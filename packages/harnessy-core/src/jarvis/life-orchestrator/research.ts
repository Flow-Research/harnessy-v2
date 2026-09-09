import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { readingIdentity } from "./identity.ts";
import { LifeOrchestratorError, type LifeReadingInput } from "./models.ts";

export interface LifeFeedSource {
	readonly name: string;
	readonly url: string;
	readonly topic: string;
	readonly enabled: boolean;
	readonly format?: "rss" | "hn-search";
	readonly maxItemsPerPoll: number;
	readonly maxPerBrief?: number;
	readonly evergreenEnabled: boolean;
	readonly maxEvergreenPerPoll: number;
	readonly evergreenKeywords: ReadonlyArray<string>;
	readonly includeKeywords?: ReadonlyArray<string>;
	readonly includeScope?: "title" | "title-description";
	readonly excludeTitlePatterns?: ReadonlyArray<string>;
}

export interface LifeResearchOptions {
	readonly topic: string;
	readonly sources: ReadonlyArray<LifeFeedSource>;
	readonly now: Date;
	readonly lookbackDays: number;
	readonly maximum: number;
	readonly fetch?: typeof globalThis.fetch;
}

export interface LifeResearchDiscovery {
	readonly candidates: ReadonlyArray<LifeReadingInput>;
	readonly sourcesAttempted: number;
	readonly sourceFailures: ReadonlyArray<string>;
}

interface ParsedFeedEntry {
	readonly title: string;
	readonly url: string;
	readonly publishedAt: string | null;
	readonly description: string;
}

const MAX_RESEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;

const readBoundedResponseText = async (response: Response): Promise<string> => {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_RESEARCH_RESPONSE_BYTES) {
		throw new Error(`response exceeds ${MAX_RESEARCH_RESPONSE_BYTES} bytes`);
	}
	if (response.body === null) {
		const body = await response.text();
		if (new TextEncoder().encode(body).byteLength > MAX_RESEARCH_RESPONSE_BYTES) {
			throw new Error(`response exceeds ${MAX_RESEARCH_RESPONSE_BYTES} bytes`);
		}
		return body;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let body = "";
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.byteLength;
		if (bytes > MAX_RESEARCH_RESPONSE_BYTES) {
			await reader.cancel();
			throw new Error(`response exceeds ${MAX_RESEARCH_RESPONSE_BYTES} bytes`);
		}
		body += decoder.decode(chunk.value, { stream: true });
	}
	return body + decoder.decode();
};

/** Parse Hacker News Algolia story search results while retaining the submitted project URL. */
export const parseHnSearch = (value: unknown): ReadonlyArray<ParsedFeedEntry> => {
	const root = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	if (!Array.isArray(root.hits)) return [];
	return root.hits.flatMap((rawHit) => {
		if (typeof rawHit !== "object" || rawHit === null) return [];
		const hit = rawHit as Record<string, unknown>;
		const title =
			typeof hit.title === "string"
				? hit.title.trim()
				: typeof hit.story_title === "string"
					? hit.story_title.trim()
					: "";
		const url =
			typeof hit.url === "string" ? hit.url.trim() : typeof hit.story_url === "string" ? hit.story_url.trim() : "";
		const createdAt = typeof hit.created_at === "string" ? isoDate(hit.created_at) : null;
		const description = [hit.story_text, hit.url]
			.filter((item): item is string => typeof item === "string")
			.join(" ");
		return title.length > 0 && /^https?:\/\//i.test(url) ? [{ title, url, publishedAt: createdAt, description }] : [];
	});
};

const decodeXml = (value: string): string =>
	value
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
		.replace(/\s+/g, " ")
		.trim();

const elementText = (block: string, names: ReadonlyArray<string>): string => {
	for (const name of names) {
		const match = block.match(
			new RegExp(
				`<(?:(?:[A-Za-z0-9_-]+):)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:[A-Za-z0-9_-]+):)?${name}>`,
				"i",
			),
		);
		if (match?.[1] !== undefined) return decodeXml(match[1]);
	}
	return "";
};

const isoDate = (value: string): string | null => {
	if (value.trim().length === 0) return null;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
};

/** Parse bounded RSS 2.0 and Atom metadata without fetching article bodies. */
export const parseLifeFeed = (xml: string): ReadonlyArray<ParsedFeedEntry> => {
	const rssItems = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((match) => match[1] ?? "");
	if (rssItems.length > 0) {
		return rssItems.map((block) => ({
			title: elementText(block, ["title"]),
			url: elementText(block, ["link", "guid"]),
			publishedAt: isoDate(elementText(block, ["pubDate", "date", "published", "updated"])),
			description: elementText(block, ["description", "summary", "content"]),
		}));
	}
	return [...xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?entry(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?entry>/gi)].map(
		(match) => {
			const block = match[1] ?? "";
			const linkMatch = block.match(/<(?:[A-Za-z0-9_-]+:)?link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?\s*>/i);
			return {
				title: elementText(block, ["title"]),
				url: linkMatch?.[1] === undefined ? elementText(block, ["link", "id"]) : decodeXml(linkMatch[1]),
				publishedAt: isoDate(elementText(block, ["published", "updated", "date"])),
				description: elementText(block, ["summary", "content", "description"]),
			};
		},
	);
};

const evergreenScore = (entry: ParsedFeedEntry, keywords: ReadonlyArray<string>): number => {
	const title = entry.title.toLowerCase();
	const description = entry.description.toLowerCase();
	return keywords.reduce((score, rawKeyword) => {
		const keyword = rawKeyword.trim().toLowerCase();
		if (keyword.length === 0) return score;
		if (title.includes(keyword)) return score + 3;
		if (description.includes(keyword)) return score + 1;
		return score;
	}, 0);
};

const feedCandidates = (
	entries: ReadonlyArray<ParsedFeedEntry>,
	source: LifeFeedSource,
	now: Date,
	lookbackDays: number,
): ReadonlyArray<LifeReadingInput> => {
	const cutoff = now.getTime() - Math.max(1, lookbackDays) * 86_400_000;
	const excludedTitle = (title: string) =>
		(source.excludeTitlePatterns ?? []).some((pattern) =>
			title.toLocaleLowerCase().includes(pattern.trim().toLocaleLowerCase()),
		);
	const includedEntry = (entry: ParsedFeedEntry) => {
		const keywords = source.includeKeywords ?? [];
		if (keywords.length === 0) return true;
		const haystack = (
			source.includeScope === "title" ? entry.title : `${entry.title} ${entry.description}`
		).toLocaleLowerCase();
		return keywords.some((keyword) => haystack.includes(keyword.trim().toLocaleLowerCase()));
	};
	const eligible = entries
		.filter(
			(entry) =>
				entry.title.length > 0 &&
				entry.url.length > 0 &&
				entry.publishedAt !== null &&
				includedEntry(entry) &&
				!excludedTitle(entry.title),
		)
		.map((entry) => ({
			entry,
			published: Date.parse(entry.publishedAt ?? ""),
			score: evergreenScore(entry, source.evergreenKeywords),
		}))
		.filter(({ published }) => Number.isFinite(published) && published <= now.getTime() + 7 * 86_400_000);
	const recent = eligible
		.filter(({ published }) => published >= cutoff)
		.sort((left, right) => right.published - left.published)
		.slice(0, Math.max(1, source.maxItemsPerPoll));
	const recentUrls = new Set(recent.map(({ entry }) => entry.url));
	const evergreen = source.evergreenEnabled
		? eligible
				.filter(({ entry, published, score }) => published < cutoff && score > 0 && !recentUrls.has(entry.url))
				.sort((left, right) => right.score - left.score || right.published - left.published)
				.slice(0, Math.max(0, source.maxEvergreenPerPoll))
		: [];
	return [...recent, ...evergreen].map(({ entry }) => ({
		url: entry.url,
		title: entry.title,
		topic: source.topic || source.name,
		publishedAt: entry.publishedAt,
		sourceName: source.name,
		sourceKind: "rss",
	}));
};

const record = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const stringValue = (value: unknown): string | null =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const firstString = (value: unknown): string | null => {
	if (!Array.isArray(value)) return stringValue(value);
	return value.map(stringValue).find((item) => item !== null) ?? null;
};

const crossrefDate = (item: Record<string, unknown>): string | null => {
	for (const field of ["published-print", "published-online", "published", "created"]) {
		const container = record(item[field]);
		const parts = container?.["date-parts"];
		if (!Array.isArray(parts) || !Array.isArray(parts[0])) continue;
		const [year, month = 1, day = 1] = parts[0];
		if (typeof year !== "number" || typeof month !== "number" || typeof day !== "number") continue;
		const date = new Date(Date.UTC(year, month - 1, day));
		if (Number.isFinite(date.getTime())) return date.toISOString();
	}
	return null;
};

/** Parse Crossref's public works response into publisher-identified reading candidates. */
export const parseCrossrefWorks = (value: unknown, topic: string): ReadonlyArray<LifeReadingInput> => {
	const message = record(record(value)?.message);
	const items = message?.items;
	if (!Array.isArray(items)) return [];
	const parsed: Array<LifeReadingInput> = [];
	for (const rawItem of items) {
		const item = record(rawItem);
		if (item === null) continue;
		const doi = stringValue(item.DOI);
		const title = firstString(item.title);
		if (doi === null || title === null) continue;
		const publisher = stringValue(item.publisher) ?? firstString(item["container-title"]) ?? "Crossref";
		parsed.push({
			url: `https://doi.org/${doi}`,
			title,
			topic,
			publishedAt: crossrefDate(item),
			sourceName: publisher,
			sourceKind: "crossref",
			sourceId: `doi:${doi}`,
		});
	}
	return parsed;
};

/** Discover feed and scholarly sources concurrently; individual source failures remain isolated. */
export const discoverLifeReadings = (
	options: LifeResearchOptions,
): Effect.Effect<LifeResearchDiscovery, LifeOrchestratorError> =>
	Effect.tryPromise({
		try: async () => {
			const fetcher = options.fetch ?? globalThis.fetch;
			const activeSources = options.sources.filter((source) => source.enabled);
			const crossrefUrl = new URL("https://api.crossref.org/works");
			crossrefUrl.searchParams.set("query.bibliographic", options.topic);
			crossrefUrl.searchParams.set("rows", String(Math.max(3, Math.min(options.maximum * 3, 30))));
			crossrefUrl.searchParams.set(
				"select",
				"DOI,title,publisher,container-title,published,published-print,published-online,created",
			);
			const requests: ReadonlyArray<{
				readonly name: string;
				readonly url: string;
				readonly parse: (body: string) => ReadonlyArray<LifeReadingInput>;
			}> = [
				...activeSources.map((source) => ({
					name: source.name,
					url: source.url,
					parse: (body: string) =>
						feedCandidates(
							source.format === "hn-search" ? parseHnSearch(JSON.parse(body) as unknown) : parseLifeFeed(body),
							source,
							options.now,
							options.lookbackDays,
						),
				})),
				{
					name: "Crossref",
					url: crossrefUrl.toString(),
					parse: (body: string) => parseCrossrefWorks(JSON.parse(body) as unknown, options.topic),
				},
			];
			const failures: Array<string> = [];
			const requestGroups = new Map<
				string,
				Array<{ readonly index: number; readonly request: (typeof requests)[number] }>
			>();
			for (const [index, request] of requests.entries()) {
				if (!URL.canParse(request.url)) {
					failures.push(`${request.name}: invalid URL`);
					continue;
				}
				const hostname = new URL(request.url).hostname;
				const group = requestGroups.get(hostname) ?? [];
				group.push({ index, request });
				requestGroups.set(hostname, group);
			}
			const outcomes: Array<PromiseSettledResult<ReadonlyArray<LifeReadingInput>> | undefined> = Array.from({
				length: requests.length,
			});
			await Promise.all(
				[...requestGroups.values()].map(async (group) => {
					for (const { index, request } of group) {
						const [outcome] = await Promise.allSettled([
							(async () => {
								const response = await fetcher(request.url, {
									headers: {
										"User-Agent": "Harnessy-Life-Orchestrator/2.0 (mailto:research@flow.foundation)",
									},
									signal: AbortSignal.timeout(20_000),
								});
								if (!response.ok) throw new Error(`HTTP ${response.status}`);
								return request.parse(await readBoundedResponseText(response));
							})(),
						]);
						outcomes[index] = outcome;
					}
				}),
			);
			const groups: Array<ReadonlyArray<LifeReadingInput>> = [];
			const identities = new Set<string>();
			for (const [index, outcome] of outcomes.entries()) {
				if (outcome === undefined) continue;
				if (outcome.status === "rejected") {
					failures.push(
						`${requests[index]?.name ?? "source"}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
					);
					continue;
				}
				groups.push(outcome.value);
			}
			const candidates: Array<LifeReadingInput> = [];
			const largestGroup = Math.max(0, ...groups.map((group) => group.length));
			for (let itemIndex = 0; itemIndex < largestGroup && candidates.length < options.maximum; itemIndex += 1) {
				for (const group of groups) {
					const candidate = group[itemIndex];
					if (candidate === undefined) continue;
					const normalized = Result.try(() => readingIdentity(candidate));
					if (Result.isFailure(normalized) || identities.has(normalized.success.identity)) continue;
					identities.add(normalized.success.identity);
					candidates.push(candidate);
					if (candidates.length >= options.maximum) break;
				}
			}
			return {
				candidates: candidates.slice(0, Math.max(0, options.maximum)),
				sourcesAttempted: requests.length,
				sourceFailures: failures,
			};
		},
		catch: (cause) =>
			new LifeOrchestratorError({ code: "research_failed", message: "Life reading discovery failed.", cause }),
	});

/** Parse the ordered topic list from the private steering document. */
export const parseLifeResearchTopics = (markdown: string): ReadonlyArray<string> => {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex((line) => /^## Current Topics\s*$/.test(line));
	if (start < 0) return [];
	const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line));
	const body = lines.slice(start + 1, endOffset < 0 ? lines.length : start + 1 + endOffset);
	return body
		.map(
			(line) =>
				line
					.trim()
					.match(/^[-*]\s+(.+)$/)?.[1]
					?.trim() ?? "",
		)
		.filter((topic) => topic.length > 0);
};

/** Rotate predictably so scheduled research covers the full competence cycle. */
export const chooseLifeResearchTopic = (topics: ReadonlyArray<string>, date: Date): string => {
	if (topics.length === 0)
		throw new LifeOrchestratorError({
			code: "research_failed",
			message: "No current research topics are configured.",
		});
	const day = Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000);
	return topics[day % topics.length] ?? topics[0] ?? "";
};
