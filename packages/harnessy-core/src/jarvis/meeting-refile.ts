/**
 * Move misfiled meeting notes to the right project folder.
 *
 * The input is an explicit manifest: each entry names a note under
 * `<private root>/<project>/meetings/` and the project it belongs to. The plan
 * is read-only. It gives each entry a status and the whole plan a digest (the
 * plan id). `--apply` runs only with that id, so the moves that run are exactly
 * the ones that were reviewed; any change to the manifest, a note or a
 * destination changes the id and refuses the apply.
 *
 * A move writes the destination with `Project:` set to the new project, never
 * over an existing file, and then replaces the source with a one-line stub that
 * links to the new path. Old links resolve, and the Fathom import treats the
 * stub as the note that is already present.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as Result from "effect/Result";
import { parse } from "yaml";

import { safeProjectSlug } from "./fathom/routes.ts";

export const MEETING_REFILE_MANIFEST_MAX_BYTES = 64 * 1024;
export const MEETING_REFILE_MAX_MOVES = 200;
const NOTE_MAX_BYTES = 512 * 1024;
/** Publication states in which a note may still be published from its current path. */
const ACTIVE_PUBLICATION: ReadonlySet<string> = new Set(["pending_review", "approved", "publishing", "blocked"]);
const STUB = /^Moved to \[[^\]\n]+\]\(([^)\n]+)\)[^\n]*$/u;

export type MeetingRefileStatus =
	/** Ready to move. */
	| "ready"
	/** The destination already holds the moved note; only the stub is missing. */
	| "stub_pending"
	/** The source is already a stub that points at the destination. */
	| "already_moved"
	| "missing_source"
	| "destination_exists"
	| "unknown_project"
	| "same_project"
	| "invalid_path"
	/** The note is queued for publication from its current path. */
	| "publication_active";

export interface MeetingRefileEntry {
	readonly source: string;
	readonly destination: string;
	readonly project: string;
	readonly status: MeetingRefileStatus;
	readonly title: string | null;
	readonly fromProject: string | null;
	readonly publication: string | null;
	/** SHA-256 of the source bytes at plan time, or null when unreadable. */
	readonly sourceSha256: string | null;
}

export interface MeetingRefilePlan {
	readonly planId: string;
	readonly privateRoot: string;
	readonly manifest: string;
	readonly entries: ReadonlyArray<MeetingRefileEntry>;
	readonly counts: Readonly<Record<MeetingRefileStatus, number>>;
}

export interface MeetingRefileApplyResult {
	readonly planId: string;
	readonly moved: ReadonlyArray<string>;
	readonly stubbed: ReadonlyArray<string>;
	readonly skipped: number;
}

export class MeetingRefileError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "MeetingRefileError";
		this.code = code;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

interface ManifestMove {
	readonly source: string;
	readonly project: string;
}

const readManifest = (path: string): ReadonlyArray<ManifestMove> => {
	const info = Result.try(() => lstatSync(path));
	if (Result.isFailure(info) || !info.success.isFile())
		throw new MeetingRefileError("manifest_missing", `Manifest is not a regular file: ${path}`);
	if (info.success.size > MEETING_REFILE_MANIFEST_MAX_BYTES)
		throw new MeetingRefileError("manifest_too_large", "Manifest is larger than 64 KiB.");
	const data = Result.try((): unknown => parse(readFileSync(path, "utf8")));
	if (
		Result.isFailure(data) ||
		!isRecord(data.success) ||
		data.success.version !== 1 ||
		!Array.isArray(data.success.moves)
	)
		throw new MeetingRefileError("manifest_invalid", "Manifest needs `version: 1` and a `moves` list.");
	const moves = data.success.moves;
	if (moves.length === 0 || moves.length > MEETING_REFILE_MAX_MOVES)
		throw new MeetingRefileError("manifest_invalid", `Manifest needs 1 to ${MEETING_REFILE_MAX_MOVES} moves.`);
	return moves.map((move, index) => {
		if (!isRecord(move) || typeof move.source !== "string" || typeof move.project !== "string")
			throw new MeetingRefileError("manifest_invalid", `Move ${index + 1} needs \`source\` and \`project\`.`);
		return { source: move.source.trim(), project: move.project.trim() };
	});
};

const metadataValue = (markdown: string, key: string): string | null => {
	const match = new RegExp(`^\\s*-\\s*${key}:\\s*(.+?)\\s*$`, "mu").exec(markdown.split("\n").slice(0, 80).join("\n"));
	return match?.[1] ?? null;
};

const titleOf = (markdown: string): string | null => /^# (.+)$/mu.exec(markdown)?.[1]?.trim() ?? null;

/** The note with `Project:` set to `project`, added after `Source Ref:` when absent. */
export const withProject = (markdown: string, project: string): string => {
	if (/^- Project: .*$/mu.test(markdown)) return markdown.replace(/^- Project: .*$/mu, `- Project: ${project}`);
	if (/^- Source Ref: .*$/mu.test(markdown))
		return markdown.replace(/^(- Source Ref: .*)$/mu, `$1\n- Project: ${project}`);
	return markdown.replace(/^(## Metadata\n\n)/mu, `$1- Project: ${project}\n`);
};

/** The one-line stub left at the old path. The link is relative, so it works in any checkout. */
export const refileStub = (source: string, destination: string, privateRoot: string, date: string): string =>
	`Moved to [${relative(privateRoot, destination)}](${relative(dirname(source), destination).split(sep).join("/")}) on ${date}.\n`;

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const regularFile = (path: string): boolean => {
	const info = Result.try(() => lstatSync(path));
	return Result.isSuccess(info) && info.success.isFile() && !info.success.isSymbolicLink();
};

const publicationStates = (database: string | undefined, paths: ReadonlyArray<string>): ReadonlyMap<string, string> => {
	if (database === undefined || !regularFile(database)) return new Map();
	const read = Result.try(() => {
		const db = new DatabaseSync(database, { readOnly: true });
		try {
			const statement = db.prepare("SELECT status FROM publication_items WHERE note_path = ?");
			const states = new Map<string, string>();
			for (const path of paths) {
				const row = statement.get(path) as { status?: unknown } | undefined;
				if (typeof row?.status === "string") states.set(path, row.status);
			}
			return states;
		} finally {
			db.close();
		}
	});
	return Result.isSuccess(read) ? read.success : new Map();
};

const planEntry = (
	privateRoot: string,
	move: ManifestMove,
	publication: ReadonlyMap<string, string>,
): MeetingRefileEntry => {
	const project = safeProjectSlug(move.project);
	const source = resolve(privateRoot, move.source);
	const inside = relative(privateRoot, source).split(sep);
	const base = {
		source,
		project,
		title: null,
		fromProject: null,
		publication: publication.get(source) ?? null,
		sourceSha256: null,
	};
	// `<project>/meetings/<...>.md`, inside the private root, with no `..`.
	if (
		isAbsolute(move.source) ||
		inside.includes("..") ||
		inside.length < 3 ||
		inside[1] !== "meetings" ||
		!source.endsWith(".md")
	)
		return { ...base, destination: source, status: "invalid_path" };
	const destination = join(privateRoot, project, "meetings", ...inside.slice(2));
	if (project.length === 0 || project !== move.project.toLowerCase() || !existsSync(join(privateRoot, project)))
		return { ...base, destination, status: "unknown_project" };
	if (project === inside[0]) return { ...base, destination, status: "same_project" };
	if (!regularFile(source)) return { ...base, destination, status: "missing_source" };
	if (lstatSync(source).size > NOTE_MAX_BYTES) return { ...base, destination, status: "invalid_path" };
	const bytes = readFileSync(source);
	const markdown = bytes.toString("utf8");
	const described = {
		...base,
		destination,
		title: titleOf(markdown),
		fromProject: metadataValue(markdown, "Project"),
		sourceSha256: sha256(bytes),
	};
	const stub = STUB.exec(markdown.trim());
	if (stub !== null) {
		const target = resolve(dirname(source), stub[1]!);
		return {
			...described,
			status: target === destination && regularFile(destination) ? "already_moved" : "invalid_path",
		};
	}
	if (existsSync(destination)) {
		const same = regularFile(destination) && readFileSync(destination, "utf8") === withProject(markdown, project);
		return { ...described, status: same ? "stub_pending" : "destination_exists" };
	}
	if (described.publication !== null && ACTIVE_PUBLICATION.has(described.publication))
		return { ...described, status: "publication_active" };
	return { ...described, status: "ready" };
};

const STATUSES: ReadonlyArray<MeetingRefileStatus> = [
	"ready",
	"stub_pending",
	"already_moved",
	"missing_source",
	"destination_exists",
	"unknown_project",
	"same_project",
	"invalid_path",
	"publication_active",
];

/** Build the read-only plan. Never writes. */
export const planMeetingRefile = (options: {
	readonly privateRoot: string;
	readonly manifest: string;
	/** `meeting-publication.sqlite3`, opened read-only to report each note's publication state. */
	readonly publicationDatabase?: string;
	readonly now?: Date;
}): MeetingRefilePlan => {
	const privateRoot = resolve(options.privateRoot);
	if (!existsSync(privateRoot) || !lstatSync(privateRoot).isDirectory())
		throw new MeetingRefileError("private_root_missing", `Private root is not a directory: ${privateRoot}`);
	const manifest = resolve(options.manifest);
	const moves = readManifest(manifest);
	const sources = moves.map((move) => resolve(privateRoot, move.source));
	if (new Set(sources).size !== sources.length)
		throw new MeetingRefileError("manifest_invalid", "Manifest lists the same source twice.");
	const publication = publicationStates(options.publicationDatabase, sources);
	const entries = moves.map((move) => planEntry(privateRoot, move, publication));
	const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<MeetingRefileStatus, number>;
	for (const entry of entries) counts[entry.status] += 1;
	const planId = sha256(
		JSON.stringify(
			entries.map((entry) => [entry.source, entry.destination, entry.project, entry.status, entry.sourceSha256]),
		),
	).slice(0, 16);
	return { planId, privateRoot, manifest, entries, counts };
};

const atomicWrite = (path: string, content: string, exclusive: boolean): void => {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	if (exclusive) {
		writeFileSync(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
		return;
	}
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
	renameSync(temporary, path);
};

/**
 * Run the moves of a reviewed plan. `confirm` must equal the plan id of a
 * fresh plan; otherwise nothing is written.
 */
export const applyMeetingRefile = (
	options: Parameters<typeof planMeetingRefile>[0] & { readonly confirm: string },
): MeetingRefileApplyResult => {
	const plan = planMeetingRefile(options);
	if (options.confirm !== plan.planId)
		throw new MeetingRefileError(
			"plan_changed",
			`Plan id is ${plan.planId}, not ${options.confirm}. Run the dry run again and review it.`,
		);
	const date = (options.now ?? new Date()).toISOString().slice(0, 10);
	const moved: string[] = [];
	const stubbed: string[] = [];
	let skipped = 0;
	for (const entry of plan.entries) {
		if (entry.status !== "ready" && entry.status !== "stub_pending") {
			skipped += 1;
			continue;
		}
		const bytes = readFileSync(entry.source);
		if (sha256(bytes) !== entry.sourceSha256)
			throw new MeetingRefileError("source_changed", `Source changed after planning: ${entry.source}`);
		if (entry.status === "ready") {
			atomicWrite(entry.destination, withProject(bytes.toString("utf8"), entry.project), true);
			moved.push(entry.destination);
		}
		atomicWrite(entry.source, refileStub(entry.source, entry.destination, plan.privateRoot, date), false);
		stubbed.push(entry.source);
	}
	return { planId: plan.planId, moved, stubbed, skipped };
};

/** `Moved to [...](...)` stubs left by a re-file. */
export const isRefileStub = (markdown: string): boolean => STUB.test(markdown.trim());
