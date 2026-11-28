/**
 * Conservative title similarity for matching a reworded brief item to an open task.
 *
 * Fuzzy matching is a fallback: a task id the brief carries, the fingerprint and
 * the exact normalised title are tried first. A fuzzy match needs a unique
 * candidate at or above `FUZZY_THRESHOLD`, the same numbers on both sides, and
 * at least `FUZZY_MIN_TOKENS` content words; shorter titles must have the same
 * content words.
 */
import { plainText } from "../../read-model/followups.ts";

/** Minimum Dice coefficient over content-word sets for a fuzzy match. */
export const FUZZY_THRESHOLD = 0.8;
/** Titles with fewer content words than this match only when their word sets are equal. */
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
	"for",
	"from",
	"in",
	"into",
	"is",
	"it",
	"its",
	"of",
	"on",
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

const words = (value: string): string[] =>
	plainText(value)
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/['’]s\b/gu, "")
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word !== "");

/**
 * The identity of a line within one brief: case, Markdown, punctuation and
 * whitespace removed. Two lines with the same key are the same task.
 */
export const titleIdentityKey = (value: string): string => words(value).join(" ");

const stem = (word: string): string =>
	word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;

/** Content words: identity words without stopwords, with a plural "s" removed. */
export const contentTokens = (value: string): ReadonlySet<string> =>
	new Set(
		words(value)
			.filter((word) => !STOPWORDS.has(word))
			.map(stem),
	);

const numbers = (tokens: ReadonlySet<string>): string =>
	[...tokens]
		.filter((token) => /\p{N}/u.test(token))
		.sort()
		.join(" ");

/** Dice coefficient of the two titles' content words, with the short-title and number guards. */
export const titleSimilarity = (a: string, b: string): number => {
	const left = contentTokens(a);
	const right = contentTokens(b);
	if (left.size === 0 || right.size === 0) return 0;
	if (numbers(left) !== numbers(right)) return 0;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared += 1;
	if (left.size < FUZZY_MIN_TOKENS || right.size < FUZZY_MIN_TOKENS)
		return shared === left.size && shared === right.size ? 1 : 0;
	return (2 * shared) / (left.size + right.size);
};

/** The one item whose title scores at or above the threshold, or undefined when none or several do. */
export const uniqueFuzzyMatch = <T extends { readonly title: string }>(
	title: string,
	pool: ReadonlyArray<T>,
): T | undefined => {
	const hits = pool.filter((item) => titleSimilarity(title, item.title) >= FUZZY_THRESHOLD);
	return hits.length === 1 ? hits[0] : undefined;
};
