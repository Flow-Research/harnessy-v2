import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AccountScopeMapping, InventoryRoot } from "../../src/meeting-context-inventory.ts";
import { parseWorkspaceManifest, type WorkspaceManifest } from "../../src/workspace.ts";

export const INBOX = "private/owner/meeting-inbox/fathom";
export const NOTES = "private/owner/meetings";
export const ROOTS: ReadonlyArray<InventoryRoot> = [
	{ kind: "fathom-inbox", path: INBOX },
	{ kind: "legacy-notes", path: NOTES },
];

/** Account labels are local credential names; scopes are the stable tenants they bind to. */
export const SCOPES: ReadonlyArray<AccountScopeMapping> = [
	{ provider: "fathom", accountLabel: "work", scope: "fathom:tenant-flow" },
	{ provider: "fathom", accountLabel: "personal", scope: "fathom:tenant-personal" },
];

export const OWNER = "owner@example.test";

/** Project checkouts are deliberately absent: relationships come from the registry, not local vaults. */
export const WORKSPACE: WorkspaceManifest = parseWorkspaceManifest({
	version: 1,
	id: "ws-synthetic",
	contextDir: ".jarvis/context",
	projects: [
		{ id: "garden", path: "garden", contextDir: ".jarvis/context" },
		{ id: "workstream", path: "workstream", contextDir: ".jarvis/context" },
		{ id: "life", path: "life", contextDir: ".jarvis/context" },
	],
});

export const GARDEN = "ws-synthetic/garden";
export const WORKSTREAM = "ws-synthetic/workstream";
export const LIFE = "ws-synthetic/life";

const temporary: string[] = [];

/** A context root with both selected roots present and empty. */
export const createContextRoot = (): string => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "meeting context ")));
	temporary.push(directory);
	for (const root of ROOTS) mkdirSync(join(directory, root.path), { recursive: true });
	return directory;
};

export const removeContextRoots = (): void => {
	for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
};

export const writeFile = (root: string, ref: string, content: string | Uint8Array): string => {
	const path = join(root, ref);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return ref;
};

export interface SyntheticSegment {
	readonly speaker?: string;
	readonly timestamp?: string;
	readonly text: string;
}

export const segments = (prefix: string, count: number): SyntheticSegment[] =>
	Array.from({ length: count }, (_, index) => ({
		speaker: index % 2 === 0 ? "Ada" : "Grace",
		timestamp: `00:00:${String(index).padStart(2, "0")}`,
		text: `${prefix} segment ${index}.`,
	}));

export interface EnvelopeOptions {
	readonly account?: string;
	readonly bucket?: "pending" | "processed" | "invalid";
	readonly title?: string;
	readonly transcript?: unknown;
	readonly summary?: string;
	readonly verified?: boolean;
	readonly envelopeAccount?: string;
	readonly fetchedAt?: string;
	readonly filename?: string;
}

/** Same layout and shape as FathomFileStore.putPending. */
export const envelopeRef = (recordingId: string | number, options: EnvelopeOptions = {}): string =>
	`${INBOX}/${options.account ?? "work"}/${options.bucket ?? "pending"}/${
		options.filename ?? `${createHash("sha256").update(String(recordingId)).digest("hex")}.json`
	}`;

export const writeEnvelope = (root: string, recordingId: string | number, options: EnvelopeOptions = {}): string => {
	const account = options.account ?? "work";
	const payload: Record<string, unknown> = {
		recording_id: recordingId,
		meeting_title: options.title ?? `Synthetic meeting ${recordingId}`,
		created_at: "2026-10-01T10:00:00Z",
		scheduled_start_time: "2026-10-01T10:00:00Z",
	};
	if (options.transcript !== undefined) payload.transcript = options.transcript;
	if (options.summary !== undefined) payload.default_summary = { markdown_formatted: options.summary };
	const envelope = {
		version: 1,
		verified: options.verified ?? true,
		account: options.envelopeAccount ?? account,
		source: "fathom-api",
		fetchedAt: options.fetchedAt ?? "2026-10-01T12:00:00Z",
		payload,
	};
	return writeFile(root, envelopeRef(recordingId, options), `${JSON.stringify(envelope)}\n`);
};

export const fathomTranscript = (items: ReadonlyArray<SyntheticSegment>): unknown[] =>
	items.map((item) => ({
		speaker: item.speaker === undefined ? undefined : { display_name: item.speaker },
		timestamp: item.timestamp,
		text: item.text,
	}));

/** Legacy note in the exact shape import-notes.ts renders (no account scope). */
export const writeLegacyNote = (root: string, name: string, recordingId: string | null): string =>
	writeFile(
		root,
		`${NOTES}/2026/Oct/${name}.md`,
		`# ${name}\n\n## Metadata\n\n- Date: 2026-10-01\n- Source Type: fathom\n${
			recordingId === null ? "" : `- Source Ref: fathom:${recordingId}\n`
		}- Participants: Unknown\n- Tags: fathom\n- Fingerprint: fathom:${recordingId}:2026-10-01T10:00:00Z\n\n## Executive Summary\n\nImported.\n`,
	);

/** Every entry under the root: type, mode, size, mtime, content hash or link target. */
export const snapshotTree = (root: string): Record<string, string> => {
	const result: Record<string, string> = {};
	const walk = (directory: string, prefix: string): void => {
		for (const name of readdirSync(directory).sort()) {
			const path = join(directory, name);
			const ref = prefix ? `${prefix}/${name}` : name;
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) result[ref] = `link:${readlinkSync(path)}`;
			else if (stat.isDirectory()) {
				result[ref] = `dir:${stat.mode}`;
				walk(path, ref);
			} else
				result[ref] =
					`file:${stat.mode}:${stat.size}:${stat.mtimeMs}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
		}
	};
	walk(root, "");
	return result;
};
