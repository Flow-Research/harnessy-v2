import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import * as Result from "effect/Result";

import { extractWorthReadingUrls } from "./artifact.ts";
import { LifeBackfillResult, type LifeReadingInput } from "./models.ts";

export interface LifeDeliveredHistory {
	readonly result: LifeBackfillResult;
	readonly entries: ReadonlyArray<{ readonly url: string; readonly briefPath: string; readonly deliveredAt: string }>;
}

const walk = (root: string): ReadonlyArray<string> => {
	if (!existsSync(root)) return [];
	const paths: Array<string> = [];
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === "previews" || entry.name === "feedback") continue;
			const path = join(directory, entry.name);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) visit(path);
			else if (stat.isFile() && /^\d{2}-daily-brief\.md$/.test(entry.name)) paths.push(path);
		}
	};
	visit(root);
	return paths.sort();
};

/** Scan canonical delivered briefs. Preview and feedback artifacts never consume a reading. */
export const scanDeliveredLifeBriefs = (lifeDirectory: string): LifeDeliveredHistory => {
	const entries: Array<{ readonly url: string; readonly briefPath: string; readonly deliveredAt: string }> = [];
	const briefs = walk(lifeDirectory);
	for (const briefPath of briefs) {
		const markdown = readFileSync(briefPath, "utf8");
		const deliveredAt = statSync(briefPath).mtime.toISOString();
		for (const url of extractWorthReadingUrls(markdown)) entries.push({ url, briefPath, deliveredAt });
	}
	return {
		result: new LifeBackfillResult({
			briefsScanned: briefs.length,
			linksFound: entries.length,
			deliveredInserted: 0,
		}),
		entries,
	};
};

const slug = (value: string): string =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64) || "reading";

/** Maintain the transitional founder-learning source archive while SQLite remains authoritative. */
export const writeLifeResearchArtifacts = (
	rawDirectory: string,
	candidates: ReadonlyArray<LifeReadingInput>,
	discoveredAt: string,
): ReadonlyArray<string> => {
	mkdirSync(rawDirectory, { recursive: true, mode: 0o700 });
	const written: Array<string> = [];
	for (const candidate of candidates) {
		const digest = createHash("sha256").update(candidate.url).digest("hex").slice(0, 12);
		const date = candidate.publishedAt?.slice(0, 10) ?? discoveredAt.slice(0, 10);
		const path = join(rawDirectory, `${date}-v2-${slug(candidate.sourceName)}-${slug(candidate.title)}-${digest}.md`);
		if (existsSync(path)) continue;
		const markdown = `---
source_url: ${candidate.url}
source_title: ${JSON.stringify(candidate.title)}
published_at: ${candidate.publishedAt ?? ""}
fetched_at: ${discoveredAt}
selected_at: ${discoveredAt}
selection_lane: v2-ledger
research_session: v2-${discoveredAt.slice(0, 10)}
triggered_by: harnessy-v2
topic: ${JSON.stringify(candidate.topic)}
source_name: ${JSON.stringify(candidate.sourceName)}
content_mode: ${candidate.sourceKind}
---

# ${candidate.title.replace(/[\r\n]+/g, " ")}

Source: ${candidate.url}
`;
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, markdown, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, path);
		written.push(path);
	}
	return written;
};

const frontmatterValue = (value: string): string => {
	const trimmed = value.trim();
	if (!trimmed.startsWith('"')) return trimmed.replace(/^['"]|['"]$/g, "");
	const parsed = Result.try(() => JSON.parse(trimmed) as unknown);
	return Result.isSuccess(parsed) && typeof parsed.success === "string"
		? parsed.success
		: trimmed.replace(/^['"]|['"]$/g, "");
};

/** Import compatibility-agent research artifacts into the authoritative V2 ledger. */
export const readLifeResearchArtifacts = (rawDirectory: string): ReadonlyArray<LifeReadingInput> => {
	if (!existsSync(rawDirectory)) return [];
	const inputs: Array<LifeReadingInput> = [];
	for (const entry of readdirSync(rawDirectory, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const text = readFileSync(join(rawDirectory, entry.name), "utf8").slice(0, 32_000);
		const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
		if (match?.[1] === undefined) continue;
		const values = new Map<string, string>();
		for (const line of match[1].split(/\r?\n/)) {
			const separator = line.indexOf(":");
			if (separator < 1) continue;
			values.set(line.slice(0, separator).trim(), frontmatterValue(line.slice(separator + 1)));
		}
		const url = values.get("source_url") ?? "";
		if (!/^https?:\/\//i.test(url)) continue;
		const mode = values.get("content_mode") ?? "";
		inputs.push({
			url,
			title: values.get("source_title") || values.get("title") || url,
			topic: values.get("topic") || "Founder learning",
			publishedAt: values.get("published_at") || null,
			sourceName: values.get("source_name") || "Research agent",
			sourceKind: mode === "rss" ? "rss" : "agent",
			sourceId: values.get("doi") ? `doi:${values.get("doi")}` : null,
		});
	}
	return inputs;
};

/** Resolve the canonical daily brief path used by the compatibility publisher. */
export const canonicalLifeBriefPath = (lifeDirectory: string, date: Date): string => {
	const month = date.toLocaleString("en-US", { month: "short", timeZone: "Africa/Lagos" });
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Africa/Lagos",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const value = (type: "year" | "day") => parts.find((part) => part.type === type)?.value ?? "";
	return join(lifeDirectory, value("year"), month, `${value("day")}-daily-brief.md`);
};

export const compatibilityScriptPath = (scriptsDirectory: string, name: string): string =>
	join(scriptsDirectory, basename(name));
