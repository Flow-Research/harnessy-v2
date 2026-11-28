import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { plainText } from "../../read-model/followups.ts";
import {
	type ExtractedMeetingItem,
	extractMeetingItems,
	type MeetingExtractOptions,
	meetingSourceHash,
} from "./followup-extract.ts";
import type { FathomImportEnvelope } from "./ingest.ts";
import { type MeetingRoute, type MeetingRouteRules, routeMeeting } from "./routes.ts";

export interface FathomNoteImportOptions {
	readonly accounts?: ReadonlyArray<string>;
	/** `Project:` for every note when `routing` is absent. */
	readonly project?: string | null;
	readonly inboxRoot: string;
	/** The one meetings folder (`flow/meetings`). Every note is written here. */
	readonly sourceRoot: string;
	/**
	 * Set each note's `Project:` tag (and alias tags) from the route rules. The
	 * folder never changes: publication reads only `sourceRoot` and publishes a
	 * note only when its `Project:` tag is the configured project.
	 */
	readonly routing?: MeetingRouteRules;
	readonly now?: Date;
	readonly lookbackHours?: number;
	readonly limit?: number;
	/**
	 * Also return notes that exist already and whose meeting is at most this many
	 * days old, for the recapture pass. 0 (the default) returns none; at most 60.
	 */
	readonly recaptureDays?: number;
	/**
	 * Other meetings folders (`<root>/YYYY/Mmm/<file>`) where an earlier release may
	 * have written the same note. A note found there is existing, not new.
	 */
	readonly noteRoots?: ReadonlyArray<string>;
	/** Follow-up extraction settings; the meeting date is added for each note. */
	readonly extract?: Omit<MeetingExtractOptions, "meetingDate">;
}

/** One open or completed Fathom action item, as written to `## Action Items`. */
export interface FathomActionItem {
	readonly text: string;
	readonly owner: string | null;
	readonly completed: boolean;
}

/** A note written by this import, with what follow-up ingest needs. */
export interface ImportedFathomNote {
	readonly path: string;
	readonly project: string | null;
	readonly route: MeetingRoute | null;
	readonly title: string;
	readonly date: string;
	readonly fingerprint: string;
	readonly shareUrl: string | null;
	/**
	 * Follow-up candidates from action items, summary and transcript, with the
	 * 1-based line of each item in the note (1 when the note does not show it).
	 */
	readonly actionItems: ReadonlyArray<ExtractedMeetingItem & { readonly line: number }>;
	/** `meetingSourceHash` of the envelope: changes when Fathom adds action items or text. */
	readonly sourceHash: string;
	/** `new`: written by this import. `existing`: written earlier, returned for recapture. */
	readonly state: "new" | "existing";
}

export interface FathomNoteImportReceipt {
	readonly imported: number;
	readonly existing: number;
	readonly skipped: number;
	readonly paths: ReadonlyArray<string>;
	readonly notes: ReadonlyArray<ImportedFathomNote>;
	/** Existing notes inside the recapture window, newest import rules applied. */
	readonly recent: ReadonlyArray<ImportedFathomNote>;
}

const safeSlug = (value: string) =>
	value
		.normalize("NFKD")
		.replace(/[^\p{Letter}\p{Number}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase()
		.slice(0, 96) || "fathom-meeting";

const isoDate = (payload: Record<string, unknown>): string | null => {
	for (const key of ["recording_start_time", "scheduled_start_time", "created_at"]) {
		const value = payload[key];
		if (typeof value !== "string") continue;
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
	}
	return null;
};

const oneLine = (value: string, max: number): string =>
	value
		.replace(/[\p{Cc}\p{Cf}]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, max);

const titleOf = (payload: Record<string, unknown>): string =>
	String(payload.meeting_title ?? payload.title ?? `Fathom Meeting ${payload.recording_id}`).trim();

const participantsOf = (payload: Record<string, unknown>): ReadonlyArray<string> =>
	Array.isArray(payload.calendar_invitees)
		? payload.calendar_invitees
				.map((item) =>
					item && typeof item === "object" ? String((item as Record<string, unknown>).name ?? "").trim() : "",
				)
				.filter(Boolean)
		: [];

const summaryOf = (payload: Record<string, unknown>): string =>
	payload.default_summary && typeof payload.default_summary === "object"
		? String((payload.default_summary as Record<string, unknown>).markdown_formatted ?? "").trim()
		: "";

const httpsUrl = (value: unknown): string | null => {
	if (typeof value !== "string" || value.length > 2048 || !URL.canParse(value)) return null;
	return new URL(value).protocol === "https:" ? value : null;
};

/** Fathom `action_items`, bounded: at most 50 items of 300 characters. */
export const fathomActionItems = (payload: Record<string, unknown>): ReadonlyArray<FathomActionItem> => {
	if (!Array.isArray(payload.action_items)) return [];
	const items: FathomActionItem[] = [];
	for (const raw of payload.action_items) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as Record<string, unknown>;
		const text = oneLine(String(item.description ?? ""), 300);
		if (text.length === 0) continue;
		const assignee =
			item.assignee && typeof item.assignee === "object" ? (item.assignee as Record<string, unknown>) : {};
		const owner = typeof assignee.name === "string" ? oneLine(assignee.name, 64) : "";
		items.push({ text, owner: owner.length > 0 ? owner : null, completed: item.completed === true });
		if (items.length >= 50) break;
	}
	return items;
};

const actionItemLine = (item: FathomActionItem): string =>
	`- [${item.completed ? "x" : " "}] ${item.text}${item.owner === null ? "" : ` (owner: ${item.owner})`}`;

const actionItemsMarkdown = (items: ReadonlyArray<FathomActionItem>): string =>
	items.length === 0 ? "" : `## Action Items\n\n${items.map(actionItemLine).join("\n")}\n\n`;

/**
 * The 1-based note line of each item: the `## Action Items` bullet for an action
 * item, else the first line whose plain text holds the item text, else 1.
 */
const itemLines = (content: string, items: ReadonlyArray<ExtractedMeetingItem>): ReadonlyArray<number> => {
	const lines = content.split("\n");
	const plain = lines.map((line) => plainText(line).toLowerCase());
	const used = new Set<number>();
	return items.map((item) => {
		const bullets = item.source === "action_items" ? [`- [ ] ${item.text}`, `- [x] ${item.text}`] : ([] as string[]);
		let index = lines.findIndex((line, at) => !used.has(at) && bullets.some((bullet) => line.startsWith(bullet)));
		if (index < 0 && item.source !== "transcript") {
			const needle = item.text.toLowerCase().slice(0, 60);
			index = plain.findIndex((line, at) => !used.has(at) && line.includes(needle));
		}
		if (index < 0) return 1;
		used.add(index);
		return index + 1;
	});
};

const MAX_NOTE_BYTES = 1024 * 1024;

/** The note at `destination`, or the same file under one of `roots`; null when none exists. */
const existingNote = (destination: string, roots: ReadonlyArray<string>, relativePath: string): string | null => {
	if (existsSync(destination)) return destination;
	for (const root of roots) {
		const candidate = join(root, relativePath);
		if (existsSync(candidate)) return candidate;
	}
	return null;
};

/** The route for one Fathom payload, scored on the same fields the import writes. */
export const routeFathomPayload = (rules: MeetingRouteRules, payload: Record<string, unknown>): MeetingRoute =>
	routeMeeting(rules, {
		title: titleOf(payload),
		participants: participantsOf(payload),
		summary: summaryOf(payload),
		actionItems: fathomActionItems(payload).map((item) => item.text),
	});

const fingerprintOf = (payload: Record<string, unknown>): string =>
	`fathom:${payload.recording_id}:${String(payload.created_at ?? "")}`;

const markdownFor = (
	envelope: FathomImportEnvelope,
	date: string,
	source: string,
	project: string | null | undefined,
	tags: ReadonlyArray<string>,
	actionItems: ReadonlyArray<FathomActionItem>,
): string => {
	const payload = envelope.payload as Record<string, unknown>;
	const title = titleOf(payload);
	const summary = summaryOf(payload);
	const participants = participantsOf(payload).join(", ");
	const executiveSummary =
		summary.length > 0 ? summary.replace(/^## /gmu, "### ") : `Imported Fathom meeting: ${title}.`;
	const projectLine = project?.trim() ? `- Project: ${project.trim().replace(/[\r\n]+/gu, " ")}\n` : "";
	return `# ${title}\n\n## Metadata\n\n- Date: ${date}\n- Source Type: fathom\n- Source Ref: fathom:${payload.recording_id}\n${projectLine}- Participants: ${participants || "Unknown"}\n- Tags: ${["fathom", ...tags].join(", ")}\n- Fingerprint: ${fingerprintOf(payload)}\n\n## Executive Summary\n\n${executiveSummary}\n\n${actionItemsMarkdown(actionItems)}<!-- Imported by Harnessy V2 from ${source}. -->\n`;
};

const pendingFiles = (root: string, accounts?: ReadonlyArray<string>): string[] => {
	if (!existsSync(root)) return [];
	const result: string[] = [];
	for (const account of readdirSync(root, { withFileTypes: true })) {
		if (!account.isDirectory() || (accounts !== undefined && !accounts.includes(account.name))) continue;
		const pending = join(root, account.name, "pending");
		if (!existsSync(pending)) continue;
		for (const entry of readdirSync(pending, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".json")) result.push(join(pending, entry.name));
		}
	}
	return result.sort();
};

const parseEnvelope = (raw: string): FathomImportEnvelope | null => {
	const exit = Effect.runSyncExit(
		Effect.try({
			try: () => JSON.parse(raw) as FathomImportEnvelope,
			catch: () => null,
		}),
	);
	return Exit.isSuccess(exit) ? exit.value : null;
};

/** Promote only recent, verified Fathom envelopes into the canonical note source. */
export const importRecentFathomNotes = (options: FathomNoteImportOptions): FathomNoteImportReceipt => {
	const sourceRoot = resolve(options.sourceRoot);
	const inboxRoot = resolve(options.inboxRoot);
	const now = options.now ?? new Date();
	const lookbackHours = Math.max(1, Math.min(168, Math.trunc(options.lookbackHours ?? 72)));
	const floor = now.getTime() - lookbackHours * 60 * 60 * 1000;
	const recaptureDays = Math.max(0, Math.min(60, Math.trunc(options.recaptureDays ?? 0)));
	const recaptureFloor = now.getTime() - recaptureDays * 24 * 60 * 60 * 1000;
	const noteRoots = (options.noteRoots ?? []).map((root) => resolve(root)).filter((root) => root !== sourceRoot);
	const paths: string[] = [];
	const notes: ImportedFathomNote[] = [];
	const recent: ImportedFathomNote[] = [];
	let imported = 0;
	let existing = 0;
	let skipped = 0;
	// Inspect every pending envelope before applying the import cap. Hash-based
	// filenames are not chronological; slicing first can starve new calls behind
	// an old backlog.
	for (const file of pendingFiles(inboxRoot, options.accounts)) {
		const envelope = parseEnvelope(readFileSync(file, "utf8"));
		if (envelope === null) {
			skipped += 1;
			continue;
		}
		if (envelope.verified !== true || envelope.source !== "fathom-api" || !envelope.payload?.recording_id) {
			skipped += 1;
			continue;
		}
		const date = isoDate(envelope.payload as Record<string, unknown>);
		const started = date === null ? Number.NaN : new Date(`${date}T00:00:00.000Z`).getTime();
		const importable = started >= floor - 24 * 60 * 60 * 1000;
		const recapturable = recaptureDays > 0 && started >= recaptureFloor - 24 * 60 * 60 * 1000;
		if (date === null || !(importable || recapturable)) {
			skipped += 1;
			continue;
		}
		const payload = envelope.payload as Record<string, unknown>;
		const title = titleOf(payload);
		const rawId = String(payload.recording_id);
		// Preserve existing safe filenames; provider IDs must never introduce paths.
		const recordingId = /^[A-Za-z0-9_-]{1,128}$/.test(rawId)
			? rawId
			: `~${createHash("sha256").update(rawId).digest("hex")}`;
		const dateObject = new Date(`${date}T00:00:00.000Z`);
		const month = dateObject.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
		// Keep the original filename rule: changing it would re-import old notes.
		const slugTitle = String(payload.meeting_title ?? payload.title ?? "fathom-meeting");
		const filename = `${date.slice(8)}-${safeSlug(slugTitle)}-${recordingId}.md`;
		const actionItems = fathomActionItems(payload);
		const route = options.routing === undefined ? null : routeFathomPayload(options.routing, payload);
		const project = route === null ? (options.project ?? null) : route.project;
		const directory = join(sourceRoot, date.slice(0, 4), month);
		const destination = join(directory, filename);
		const extracted = extractMeetingItems(payload, { ...options.extract, meetingDate: date });
		const noteFor = (path: string, content: string, state: ImportedFathomNote["state"]): ImportedFathomNote => {
			const lines = itemLines(content, extracted);
			return {
				path,
				project,
				route,
				title,
				date,
				fingerprint: fingerprintOf(payload),
				shareUrl: httpsUrl(payload.share_url) ?? httpsUrl(payload.url),
				actionItems: extracted.map((item, index) => ({ ...item, line: lines[index]! })),
				sourceHash: meetingSourceHash(payload),
				state,
			};
		};
		const found = existingNote(destination, noteRoots, join(date.slice(0, 4), month, filename));
		if (found !== null) {
			existing += 1;
			if (recapturable) {
				const content = Effect.runSyncExit(
					Effect.try({
						try: () => {
							const bytes = readFileSync(found);
							return bytes.byteLength > MAX_NOTE_BYTES ? "" : bytes.toString("utf8");
						},
						catch: () => null,
					}),
				);
				recent.push(noteFor(found, Exit.isSuccess(content) ? content.value : "", "existing"));
			}
			continue;
		}
		if (!importable) {
			skipped += 1;
			continue;
		}
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const content = markdownFor(
			envelope,
			date,
			relative(inboxRoot, file),
			project,
			route?.aliasTags ?? [],
			actionItems,
		);
		const temporary = `${destination}.${randomUUID()}.tmp`;
		const fd = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(fd, content);
			fsyncSync(fd);
			const linked = Effect.runSyncExit(
				Effect.try({ try: () => linkSync(temporary, destination), catch: (error) => error }),
			);
			if (Exit.isFailure(linked)) {
				const error = Cause.squash(linked.cause);
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				existing += 1;
				continue;
			}
		} finally {
			closeSync(fd);
			unlinkSync(temporary);
		}
		paths.push(destination);
		notes.push(noteFor(destination, content, "new"));
		imported += 1;
		if (imported >= Math.max(1, Math.min(100, options.limit ?? 100))) break;
	}
	return { imported, existing, skipped, paths, notes, recent };
};
