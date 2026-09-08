import * as Result from "effect/Result";
import { canonicalizeReadingUrl } from "./identity.ts";
import { LifeOrchestratorError, type LifeReadingCandidate } from "./models.ts";

const WORTH_READING_HEADING = /^##\s+Worth Reading\s*$/im;
const NEXT_SECTION = /^#{1,2}\s+/m;
const MARKDOWN_LINK = /\[[^\]]*\]\((?:<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s)]+))\)/gi;

const sectionRange = (markdown: string): { readonly start: number; readonly end: number } | null => {
	const heading = WORTH_READING_HEADING.exec(markdown);
	if (heading === null) return null;
	const bodyStart = heading.index + heading[0].length;
	const following = markdown.slice(bodyStart);
	const next = NEXT_SECTION.exec(following.replace(/^\r?\n/, ""));
	if (next === null) return { start: heading.index, end: markdown.length };
	const skippedNewline = following.startsWith("\r\n") ? 2 : following.startsWith("\n") ? 1 : 0;
	return { start: heading.index, end: bodyStart + skippedNewline + next.index };
};

const MARKDOWN_INLINE_ENTITY: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	"\\": "&#92;",
	"`": "&#96;",
	"*": "&#42;",
	_: "&#95;",
	"{": "&#123;",
	"}": "&#125;",
	"[": "&#91;",
	"]": "&#93;",
	"(": "&#40;",
	")": "&#41;",
	"#": "&#35;",
	"+": "&#43;",
	"-": "&#45;",
	"!": "&#33;",
	"|": "&#124;",
};

const cleanInline = (value: string) =>
	value
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[&<>\\`*_{}[\]()#+!|-]/g, (character) => MARKDOWN_INLINE_ENTITY[character] ?? character);

const ageLabel = (publishedAt: string | null, now: Date): string => {
	if (publishedAt === null) return "publication date unavailable";
	const published = new Date(publishedAt);
	if (!Number.isFinite(published.getTime())) return "publication date unavailable";
	const ageDays = Math.max(0, Math.floor((now.getTime() - published.getTime()) / 86_400_000));
	if (ageDays < 2) return ageDays === 0 ? "published today" : "1 day old";
	if (ageDays < 60) return `${ageDays} days old`;
	const ageMonths = Math.floor(ageDays / 30);
	if (ageMonths < 24) return `${ageMonths} months old`;
	const ageYears = Math.floor(ageDays / 365);
	return `${ageYears} years old`;
};

/** Extract only links inside the canonical Worth Reading section. */
export const extractWorthReadingUrls = (markdown: string): ReadonlyArray<string> => {
	const range = sectionRange(markdown);
	if (range === null) return [];
	const section = markdown.slice(range.start, range.end);
	const urls = new Set<string>();
	for (const match of section.matchAll(MARKDOWN_LINK)) {
		const rawUrl = match[1] ?? match[2];
		if (rawUrl === undefined) continue;
		const canonical = Result.try(() => canonicalizeReadingUrl(rawUrl));
		if (Result.isSuccess(canonical)) urls.add(canonical.success);
	}
	return [...urls];
};

/** Replace model-authored recommendations with ledger-reserved candidates and an honest shortage notice. */
export const replaceWorthReadingSection = (
	markdown: string,
	candidates: ReadonlyArray<LifeReadingCandidate>,
	now: Date,
): string => {
	const lines = ["## Worth Reading", ""];
	if (candidates.length < 2) {
		lines.push(
			candidates.length === 0
				? "> Reading shortage: no unseen verified sources were available today. No previously delivered links were reused."
				: "> Reading shortage: only one unseen verified source was available today. No previously delivered links were reused.",
			"",
		);
	}
	for (const candidate of candidates) {
		lines.push(
			`- [${cleanInline(candidate.title)}](<${candidate.canonicalUrl}>) — ${cleanInline(candidate.topic)}; ${ageLabel(candidate.publishedAt, now)}; ${cleanInline(candidate.sourceName)}`,
		);
	}
	const replacement = `${lines.join("\n").trimEnd()}\n`;
	const range = sectionRange(markdown);
	if (range === null) return `${markdown.trimEnd()}\n\n${replacement}`;
	const before = markdown.slice(0, range.start).trimEnd();
	const after = markdown.slice(range.end).trimStart();
	return after.length === 0 ? `${before}\n\n${replacement}` : `${before}\n\n${replacement}\n${after}`;
};

/** Enforce that the final reading section contains exactly the reserved, never-delivered URLs. */
export const validateWorthReadingSection = (
	markdown: string,
	selected: ReadonlyArray<LifeReadingCandidate>,
	deliveredIdentities: ReadonlySet<string>,
): void => {
	const actual = extractWorthReadingUrls(markdown);
	const expected = selected.map((candidate) => candidate.canonicalUrl);
	if (actual.length !== expected.length || actual.some((url, index) => url !== expected[index])) {
		throw new LifeOrchestratorError({
			code: "artifact_invalid",
			message: "Worth Reading does not exactly match the ledger reservation.",
		});
	}
	const repeated = selected.find((candidate) => deliveredIdentities.has(candidate.identity));
	if (repeated !== undefined) {
		throw new LifeOrchestratorError({
			code: "artifact_invalid",
			message: `Previously delivered reading was selected again: ${repeated.identity}`,
		});
	}
};
