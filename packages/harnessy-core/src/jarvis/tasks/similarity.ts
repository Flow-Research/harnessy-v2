/**
 * Conservative title similarity for matching a reworded brief item to an open task.
 *
 * Fuzzy matching is a fallback: a task id the brief carries, the fingerprint and
 * the exact normalised title are tried first. When a fuzzy match is unsure, it
 * does not merge. Two titles can match only when all of these are the same on
 * both sides:
 * - the numbers and dates, in order (a date such as 2026-03-04 is one token),
 * - the currencies,
 * - negation ("not", "no", "never", "n't", ...),
 * - verb particles ("in", "up", "off", ...),
 * - named entities (a capitalised word after the first must appear on both
 *   sides) and recipients (the word after "to", "for", "with", "from" or "cc").
 * Then the Dice coefficient of the content words must reach `FUZZY_THRESHOLD`.
 * A title with fewer than `FUZZY_MIN_TOKENS` content words matches only a title
 * with the same identity key.
 */
import { plainText } from "../../read-model/followups.ts";

/** Minimum Dice coefficient over content-word sets for a fuzzy match. */
export const FUZZY_THRESHOLD = 0.85;
/** Titles with fewer content words than this match only when their identity keys are equal. */
export const FUZZY_MIN_TOKENS = 3;

const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"cc",
	"for",
	"from",
	"is",
	"it",
	"its",
	"of",
	"or",
	"our",
	"so",
	"that",
	"the",
	"their",
	"this",
	"to",
	"with",
	"your",
]);
const NEGATIONS = new Set(["not", "no", "never", "without", "cannot", "nor", "none"]);
const PARTICLES = new Set(["in", "on", "up", "down", "out", "off", "over", "back", "away", "into", "onto"]);
const RECIPIENT_LEADS = new Set(["to", "for", "with", "from", "cc"]);

/** Prefix of a currency token. It cannot start an ordinary word. */
const CURRENCY = "qxcur";

/** A currency symbol as letters, so it never counts as a number: `$` is `qxcurdg`. */
const currencyToken = (symbol: string): string =>
	` ${CURRENCY}${[...String(symbol.codePointAt(0) ?? 0)].map((digit) => String.fromCharCode(97 + Number(digit))).join("")} `;

/** Words with their original case. Dates, grouped and decimal numbers stay one token. */
const casedWords = (value: string): string[] =>
	plainText(value)
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/n['’]t\b/giu, " not")
		.replace(/['’]s\b/gu, "")
		.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/gu, " d$1$2$3 ")
		.replace(/(\d)[,](?=\d{3}\b)/gu, "$1")
		.replace(/(\d)[./:-](?=\d)/gu, "$1x")
		.replace(/\p{Sc}/gu, currencyToken)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word !== "");

const words = (value: string): string[] => casedWords(value).map((word) => word.toLowerCase());

/**
 * The identity of a line within one brief: case, Markdown, punctuation and
 * whitespace removed; numbers, dates and currencies kept.
 */
export const titleIdentityKey = (value: string): string => words(value).join(" ");

const stem = (word: string): string =>
	word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;

const hasDigit = (word: string): boolean => /\p{N}/u.test(word);

interface TitleShape {
	readonly identity: string;
	readonly content: ReadonlySet<string>;
	/** Number and date tokens in their order. */
	readonly numbers: string;
	readonly currencies: string;
	readonly negated: boolean;
	readonly particles: string;
	/** Capitalised words after the first, stemmed. */
	readonly entities: ReadonlySet<string>;
	/** The first non-stopword after "to", "for", "with", "from" or "cc", stemmed. */
	readonly recipients: string;
	/** Every word, stemmed, stopwords included. */
	readonly all: ReadonlySet<string>;
}

const sortedKey = (values: Iterable<string>): string => [...new Set(values)].sort().join(" ");

const shape = (value: string): TitleShape => {
	const cased = casedWords(value);
	const lower = cased.map((word) => word.toLowerCase());
	const entities: string[] = [];
	const recipients: string[] = [];
	for (const [index, word] of cased.entries()) {
		// A capitalised word after the first names someone or something.
		if (index > 0 && /^\p{Lu}/u.test(word)) entities.push(stem(word.toLowerCase()));
		if (!RECIPIENT_LEADS.has(lower[index]!)) continue;
		const next = lower.slice(index + 1).find((candidate) => !STOPWORDS.has(candidate));
		if (next !== undefined) recipients.push(stem(next));
	}
	return {
		identity: lower.join(" "),
		content: new Set(
			lower
				.filter((word) => !STOPWORDS.has(word) && !word.startsWith(CURRENCY))
				.filter((word) => !NEGATIONS.has(word))
				.map(stem),
		),
		numbers: lower.filter(hasDigit).join(" "),
		currencies: lower.filter((word) => word.startsWith(CURRENCY)).join(" "),
		negated: lower.some((word) => NEGATIONS.has(word)),
		particles: sortedKey(lower.filter((word) => PARTICLES.has(word))),
		entities: new Set(entities),
		recipients: sortedKey(recipients),
		all: new Set(lower.map(stem)),
	};
};

/** Dice coefficient of the two titles' content words, or 0 when any guard differs. */
export const titleSimilarity = (a: string, b: string): number => {
	const left = shape(a);
	const right = shape(b);
	if (left.content.size === 0 || right.content.size === 0) return 0;
	if (left.content.size < FUZZY_MIN_TOKENS || right.content.size < FUZZY_MIN_TOKENS)
		return left.identity === right.identity ? 1 : 0;
	// A name either side capitalises must appear on both sides, in any case.
	const named = [...left.entities, ...right.entities].every((name) => left.all.has(name) && right.all.has(name));
	if (
		!named ||
		left.numbers !== right.numbers ||
		left.currencies !== right.currencies ||
		left.negated !== right.negated ||
		left.particles !== right.particles ||
		left.recipients !== right.recipients
	)
		return 0;
	let shared = 0;
	for (const token of left.content) if (right.content.has(token)) shared += 1;
	return (2 * shared) / (left.content.size + right.content.size);
};

/** Every item whose title scores at or above the threshold. */
export const fuzzyMatches = <T extends { readonly title: string }>(title: string, pool: ReadonlyArray<T>): T[] =>
	pool.filter((item) => titleSimilarity(title, item.title) >= FUZZY_THRESHOLD);

/** The one item whose title scores at or above the threshold, or undefined when none or several do. */
export const uniqueFuzzyMatch = <T extends { readonly title: string }>(
	title: string,
	pool: ReadonlyArray<T>,
): T | undefined => {
	const hits = fuzzyMatches(title, pool);
	return hits.length === 1 ? hits[0] : undefined;
};
