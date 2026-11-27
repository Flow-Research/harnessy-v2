import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { applyMeetingRefile, isRefileStub, planMeetingRefile } from "../src/jarvis/meeting-refile.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOTE = (title: string, id: number) =>
	`# ${title}\n\n## Metadata\n\n- Date: 2026-10-22\n- Source Type: fathom\n- Source Ref: fathom:${id}\n- Project: flow\n- Participants: Ada\n- Tags: fathom\n- Fingerprint: fathom:${id}:2026-10-22T10:00:00Z\n\n## Executive Summary\n\nSummary.\n`;

const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-meeting-refile-"));
	roots.push(root);
	const privateRoot = join(root, "private");
	const month = join(privateRoot, "flow", "meetings", "2026", "Oct");
	mkdirSync(month, { recursive: true });
	for (const project of ["hiring", "acme"]) mkdirSync(join(privateRoot, project, "meetings"), { recursive: true });
	writeFileSync(join(month, "22-interview-one-101.md"), NOTE("Interview one", 101));
	writeFileSync(join(month, "22-acme-demo-102.md"), NOTE("Acme demo", 102));
	writeFileSync(join(month, "22-partner-call-103.md"), NOTE("Partner call", 103));
	const manifest = join(root, "manifest.yaml");
	writeFileSync(
		manifest,
		[
			"version: 1",
			"moves:",
			"  - source: flow/meetings/2026/Oct/22-interview-one-101.md",
			"    project: hiring",
			"  - source: flow/meetings/2026/Oct/22-acme-demo-102.md",
			"    project: acme",
			"  - source: flow/meetings/2026/Oct/22-missing-104.md",
			"    project: hiring",
			"  - source: flow/meetings/2026/Oct/22-partner-call-103.md",
			"    project: nowhere",
			"  - source: ../outside.md",
			"    project: hiring",
			"",
		].join("\n"),
	);
	return { root, privateRoot, month, manifest, now: new Date("2026-11-28T09:00:00Z") };
};

const snapshot = (dir: string): Record<string, string> => {
	const files: Record<string, string> = {};
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else files[path] = readFileSync(path, "utf8");
		}
	};
	walk(dir);
	return files;
};

describe("meeting re-file", () => {
	it("dry run lists each move with a status and writes nothing", () => {
		const setup = fixture();
		const before = snapshot(setup.root);
		const plan = planMeetingRefile({ privateRoot: setup.privateRoot, manifest: setup.manifest, now: setup.now });
		expect(snapshot(setup.root)).toEqual(before);
		expect(plan.entries.map((entry) => entry.status)).toEqual([
			"ready",
			"ready",
			"missing_source",
			"unknown_project",
			"invalid_path",
		]);
		expect(plan.entries[0]).toMatchObject({
			destination: join(setup.privateRoot, "hiring", "meetings", "2026", "Oct", "22-interview-one-101.md"),
			fromProject: "flow",
			project: "hiring",
			title: "Interview one",
		});
		expect(plan.counts.ready).toBe(2);
		expect(plan.planId).toMatch(/^[a-f0-9]{16}$/u);
		expect(planMeetingRefile({ privateRoot: setup.privateRoot, manifest: setup.manifest }).planId).toBe(plan.planId);
	});

	it("applies only with the reviewed plan id, then moves, stubs and stays idempotent", () => {
		const setup = fixture();
		const options = { privateRoot: setup.privateRoot, manifest: setup.manifest, now: setup.now };
		const before = snapshot(setup.root);
		expect(() => applyMeetingRefile({ ...options, confirm: "0000000000000000" })).toThrow(/Plan id is/u);
		expect(snapshot(setup.root)).toEqual(before);

		const plan = planMeetingRefile(options);
		const result = applyMeetingRefile({ ...options, confirm: plan.planId });
		expect(result).toMatchObject({ moved: [plan.entries[0]!.destination, plan.entries[1]!.destination], skipped: 3 });
		const moved = readFileSync(plan.entries[0]!.destination, "utf8");
		expect(moved).toContain("- Project: hiring\n");
		expect(moved).toBe(NOTE("Interview one", 101).replace("- Project: flow", "- Project: hiring"));
		expect(statSync(plan.entries[0]!.destination).mode & 0o777).toBe(0o600);
		const stub = readFileSync(plan.entries[0]!.source, "utf8");
		expect(stub).toBe(
			"Moved to [hiring/meetings/2026/Oct/22-interview-one-101.md](../../../../hiring/meetings/2026/Oct/22-interview-one-101.md) on 2026-11-28.\n",
		);
		expect(stub.trim().split("\n")).toHaveLength(1);
		expect(isRefileStub(stub)).toBe(true);
		expect(resolve(setup.month, "../../../../hiring/meetings/2026/Oct/22-interview-one-101.md")).toBe(
			plan.entries[0]!.destination,
		);

		const again = planMeetingRefile(options);
		expect(again.entries.slice(0, 2).map((entry) => entry.status)).toEqual(["already_moved", "already_moved"]);
		expect(again.planId).not.toBe(plan.planId);
		expect(() => applyMeetingRefile({ ...options, confirm: plan.planId })).toThrow(/Plan id is/u);
	});

	it("refuses to overwrite an existing destination and finishes a move that only lacks its stub", () => {
		const setup = fixture();
		const options = { privateRoot: setup.privateRoot, manifest: setup.manifest };
		const destination = join(setup.privateRoot, "hiring", "meetings", "2026", "Oct", "22-interview-one-101.md");
		mkdirSync(join(destination, ".."), { recursive: true });
		writeFileSync(destination, "a different note");
		const acme = join(setup.privateRoot, "acme", "meetings", "2026", "Oct", "22-acme-demo-102.md");
		mkdirSync(join(acme, ".."), { recursive: true });
		writeFileSync(acme, NOTE("Acme demo", 102).replace("- Project: flow", "- Project: acme"));
		const plan = planMeetingRefile(options);
		expect(plan.entries[0]!.status).toBe("destination_exists");
		expect(plan.entries[1]!.status).toBe("stub_pending");
		const result = applyMeetingRefile({ ...options, confirm: plan.planId });
		expect(result.moved).toEqual([]);
		expect(result.stubbed).toEqual([plan.entries[1]!.source]);
		expect(readFileSync(destination, "utf8")).toBe("a different note");
		expect(readFileSync(plan.entries[0]!.source, "utf8")).toBe(NOTE("Interview one", 101));
	});

	it("reports publication state and blocks a note that is still queued to publish", () => {
		const setup = fixture();
		const database = join(setup.root, "meeting-publication.sqlite3");
		const db = new DatabaseSync(database);
		db.exec("CREATE TABLE publication_items (note_path TEXT NOT NULL UNIQUE, status TEXT NOT NULL)");
		db.prepare("INSERT INTO publication_items VALUES (?, ?)").run(
			join(setup.month, "22-interview-one-101.md"),
			"archived",
		);
		db.prepare("INSERT INTO publication_items VALUES (?, ?)").run(
			join(setup.month, "22-acme-demo-102.md"),
			"pending_review",
		);
		db.close();
		const plan = planMeetingRefile({
			privateRoot: setup.privateRoot,
			manifest: setup.manifest,
			publicationDatabase: database,
		});
		expect(plan.entries[0]).toMatchObject({ status: "ready", publication: "archived" });
		expect(plan.entries[1]).toMatchObject({ status: "publication_active", publication: "pending_review" });
	});

	it("rejects malformed manifests before reading notes", () => {
		const setup = fixture();
		for (const text of [
			"moves: []",
			"version: 1\nmoves: []",
			"version: 1\nmoves:\n  - project: hiring",
			"[unclosed",
		]) {
			writeFileSync(setup.manifest, text);
			expect(() => planMeetingRefile({ privateRoot: setup.privateRoot, manifest: setup.manifest })).toThrow();
		}
		expect(existsSync(join(setup.privateRoot, "hiring", "meetings", "2026"))).toBe(false);
	});
});
