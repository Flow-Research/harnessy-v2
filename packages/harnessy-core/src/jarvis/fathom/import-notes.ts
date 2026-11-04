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

import type { FathomImportEnvelope } from "./ingest.ts";

export interface FathomNoteImportOptions {
	readonly accounts?: ReadonlyArray<string>;
	readonly project?: string | null;
	readonly inboxRoot: string;
	readonly sourceRoot: string;
	readonly now?: Date;
	readonly lookbackHours?: number;
	readonly limit?: number;
}

export interface FathomNoteImportReceipt {
	readonly imported: number;
	readonly existing: number;
	readonly skipped: number;
	readonly paths: ReadonlyArray<string>;
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

const markdownFor = (envelope: FathomImportEnvelope, date: string, source: string, project?: string | null): string => {
	const payload = envelope.payload as Record<string, unknown>;
	const title = String(payload.meeting_title ?? payload.title ?? `Fathom Meeting ${payload.recording_id}`).trim();
	const summary =
		payload.default_summary && typeof payload.default_summary === "object"
			? String((payload.default_summary as Record<string, unknown>).markdown_formatted ?? "").trim()
			: "";
	const participants = Array.isArray(payload.calendar_invitees)
		? payload.calendar_invitees
				.map((item) =>
					item && typeof item === "object" ? String((item as Record<string, unknown>).name ?? "").trim() : "",
				)
				.filter(Boolean)
				.join(", ")
		: "";
	const fingerprint = `fathom:${payload.recording_id}:${String(payload.created_at ?? "")}`;
	const executiveSummary =
		summary.length > 0 ? summary.replace(/^## /gmu, "### ") : `Imported Fathom meeting: ${title}.`;
	const projectLine = project?.trim() ? `- Project: ${project.trim().replace(/[\r\n]+/gu, " ")}\n` : "";
	return `# ${title}\n\n## Metadata\n\n- Date: ${date}\n- Source Type: fathom\n- Source Ref: fathom:${payload.recording_id}\n${projectLine}- Participants: ${participants || "Unknown"}\n- Tags: fathom\n- Fingerprint: ${fingerprint}\n\n## Executive Summary\n\n${executiveSummary}\n\n<!-- Imported by Harnessy V2 from ${source}. -->\n`;
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
	const paths: string[] = [];
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
		if (date === null || started < floor - 24 * 60 * 60 * 1000) {
			skipped += 1;
			continue;
		}
		const payload = envelope.payload as Record<string, unknown>;
		const title = String(payload.meeting_title ?? payload.title ?? "fathom-meeting");
		const rawId = String(payload.recording_id);
		// Preserve existing safe filenames; provider IDs must never introduce paths.
		const recordingId = /^[A-Za-z0-9_-]{1,128}$/.test(rawId)
			? rawId
			: `~${createHash("sha256").update(rawId).digest("hex")}`;
		const dateObject = new Date(`${date}T00:00:00.000Z`);
		const month = dateObject.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
		const directory = join(sourceRoot, date.slice(0, 4), month);
		const destination = join(directory, `${date.slice(8)}-${safeSlug(title)}-${recordingId}.md`);
		if (existsSync(destination)) {
			existing += 1;
			continue;
		}
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const content = markdownFor(envelope, date, relative(inboxRoot, file), options.project);
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
		imported += 1;
		if (imported >= Math.max(1, Math.min(100, options.limit ?? 100))) break;
	}
	return { imported, existing, skipped, paths };
};
