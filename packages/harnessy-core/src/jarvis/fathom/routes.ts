/**
 * Route a meeting to a private-context project folder.
 *
 * This is the V2 port of the Jarvis `--auto-route` rules
 * (`jarvis-cli/src/jarvis/meetings/service.py`). It reads
 * `<private root>/meeting-routes.yaml` and the project folders beside it:
 *
 * - every folder with a `status.md` or a `meetings/` folder is a route whose
 *   keyword is its own slug;
 * - `routes` in the file add keywords to a project;
 * - `project_aliases` fold a project into another one (for example
 *   `garden: flow`), and the folded slug is kept as a tag.
 *
 * A keyword scores only on a whole-word match, weighted by its word count. The
 * highest-scoring project wins. A tie, no match, or a winner without a project
 * folder falls back to the default project, so the router never invents a slug.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import * as Result from "effect/Result";
import { parse } from "yaml";

export const MEETING_ROUTES_FILE = "meeting-routes.yaml";
const ROUTES_FILE_MAX_BYTES = 256 * 1024;
/** Folders beside the projects that are not meeting routes. */
const EXCLUDED_FOLDERS: ReadonlySet<string> = new Set(["learn", "meeting-inbox", "meetings", "notes"]);

export interface MeetingRouteRules {
	readonly privateRoot: string;
	readonly defaultProject: string;
	/** Keywords per project slug, in file order. */
	readonly routes: ReadonlyMap<string, ReadonlyArray<string>>;
	/** Source slug to canonical slug. */
	readonly aliases: ReadonlyMap<string, string>;
}

export interface MeetingRouteInput {
	readonly title: string;
	readonly participants?: ReadonlyArray<string>;
	readonly summary?: string;
	readonly actionItems?: ReadonlyArray<string>;
}

export interface MeetingRoute {
	readonly project: string;
	/** Alias source slugs that matched, kept as tags (for example `garden`). */
	readonly aliasTags: ReadonlyArray<string>;
	/** True when no rule decided the project and the default was used. */
	readonly defaulted: boolean;
	readonly score: number;
}

export const safeProjectSlug = (value: string): string =>
	value
		.trim()
		.replace(/[^A-Za-z0-9_.-]+/gu, "-")
		.replace(/^[.-]+|[.-]+$/gu, "")
		.toLowerCase();

const normaliseRouteText = (value: string): string =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const keywordList = (value: unknown): ReadonlyArray<string> =>
	Array.isArray(value) ? value.map((item) => String(item)) : typeof value === "string" ? [value] : [];

const readRoutesDocument = (path: string): Record<string, unknown> => {
	if (!existsSync(path)) return {};
	const loaded = Result.try(() => {
		const info = lstatSync(path);
		if (!info.isFile() || info.size > ROUTES_FILE_MAX_BYTES) return {};
		const data: unknown = parse(readFileSync(path, "utf8"));
		return isRecord(data) ? data : { routes: data };
	});
	return Result.isSuccess(loaded) ? loaded.success : {};
};

const configuredRoutes = (data: Record<string, unknown>): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => {
	const raw = data.routes;
	if (isRecord(raw)) return Object.entries(raw).map(([project, keywords]) => [project, keywordList(keywords)]);
	if (!Array.isArray(raw)) return [];
	const result: Array<readonly [string, ReadonlyArray<string>]> = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const project = String(entry.project ?? "").trim();
		if (project.length > 0) result.push([project, keywordList(entry.keywords)]);
	}
	return result;
};

const projectFolders = (privateRoot: string): ReadonlyArray<string> => {
	const listed = Result.try(() => readdirSync(privateRoot, { withFileTypes: true }));
	if (Result.isFailure(listed)) return [];
	return listed.success
		.filter(
			(entry) =>
				entry.isDirectory() &&
				!EXCLUDED_FOLDERS.has(entry.name) &&
				(existsSync(join(privateRoot, entry.name, "status.md")) ||
					existsSync(join(privateRoot, entry.name, "meetings"))),
		)
		.map((entry) => safeProjectSlug(entry.name))
		.filter((slug) => slug.length > 0)
		.sort();
};

/** Load route rules for `privateRoot` (the folder that holds `meeting-routes.yaml`). */
export const loadMeetingRouteRules = (privateRoot: string, defaultProject: string): MeetingRouteRules => {
	const routes = new Map<string, string[]>();
	for (const slug of projectFolders(privateRoot)) routes.set(slug, [slug.replace(/-/gu, " ")]);
	const data = readRoutesDocument(join(privateRoot, MEETING_ROUTES_FILE));
	for (const [project, keywords] of configuredRoutes(data)) {
		const slug = safeProjectSlug(project);
		if (slug.length === 0) continue;
		const existing = routes.get(slug) ?? [];
		for (const keyword of keywords) {
			const cleaned = keyword.trim();
			if (cleaned.length > 0 && !existing.includes(cleaned)) existing.push(cleaned);
		}
		routes.set(slug, existing);
	}
	const aliases = new Map<string, string>();
	if (isRecord(data.project_aliases)) {
		for (const [source, target] of Object.entries(data.project_aliases)) {
			const from = safeProjectSlug(source);
			const to = safeProjectSlug(String(target));
			if (from.length > 0 && to.length > 0 && from !== to) aliases.set(from, to);
		}
	}
	return { privateRoot, defaultProject: safeProjectSlug(defaultProject) || "flow", routes, aliases };
};

const scoreKeywords = (paddedText: string, keywords: ReadonlyArray<string>): number => {
	let score = 0;
	const seen = new Set<string>();
	for (const keyword of keywords) {
		const normalised = normaliseRouteText(keyword);
		if (normalised.length === 0 || seen.has(normalised)) continue;
		seen.add(normalised);
		if (paddedText.includes(` ${normalised} `)) score += Math.max(1, normalised.split(" ").length);
	}
	return score;
};

/** Canonical slug for `project` after aliases, and the alias tag when one applied. */
export const canonicalMeetingProject = (
	rules: MeetingRouteRules,
	project: string,
): { readonly project: string; readonly aliasTags: ReadonlyArray<string> } => {
	const source = safeProjectSlug(project);
	const target = rules.aliases.get(source) ?? source;
	return { project: target, aliasTags: target !== source && source.length > 0 ? [source] : [] };
};

/**
 * Pick the project for one meeting. The text scored is the title, the
 * participants, the summary and the action items; transcripts are not scored,
 * so one passing mention cannot move a note.
 */
export const routeMeeting = (rules: MeetingRouteRules, meeting: MeetingRouteInput): MeetingRoute => {
	const fallback: MeetingRoute = { project: rules.defaultProject, aliasTags: [], defaulted: true, score: 0 };
	const text = normaliseRouteText(
		[meeting.title, ...(meeting.participants ?? []), meeting.summary ?? "", ...(meeting.actionItems ?? [])].join(
			"\n",
		),
	);
	if (text.length === 0) return fallback;
	const padded = ` ${text} `;
	const scores = new Map<string, number>();
	const tags = new Map<string, string[]>();
	for (const [slug, keywords] of rules.routes) {
		const score = scoreKeywords(padded, [slug, ...keywords]);
		if (score === 0) continue;
		const canonical = canonicalMeetingProject(rules, slug);
		scores.set(canonical.project, (scores.get(canonical.project) ?? 0) + score);
		const merged = tags.get(canonical.project) ?? [];
		for (const tag of canonical.aliasTags) if (!merged.includes(tag)) merged.push(tag);
		tags.set(canonical.project, merged);
	}
	const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
	const winner = ranked[0];
	if (winner === undefined) return fallback;
	if (ranked.length > 1 && ranked[1]![1] === winner[1]) return fallback;
	const folder = join(rules.privateRoot, winner[0]);
	if (winner[0] !== rules.defaultProject && !(existsSync(folder) && lstatSync(folder).isDirectory())) return fallback;
	return { project: winner[0], aliasTags: tags.get(winner[0]) ?? [], defaulted: false, score: winner[1] };
};

/** `<private root>/<project>/meetings`. */
export const projectMeetingsRoot = (rules: MeetingRouteRules, project: string): string =>
	join(rules.privateRoot, project, "meetings");
