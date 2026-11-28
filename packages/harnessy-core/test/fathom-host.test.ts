import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { JarvisLegacyConfig, resolveJarvisConfig } from "../src/jarvis/config-model.ts";
import { runConfiguredFathomPoll } from "../src/jarvis/fathom/host.ts";
import { JarvisPaths } from "../src/jarvis/paths.ts";
import { TasksState } from "../src/jarvis/tasks/store.ts";

const roots: string[] = [];
const fixture = (selection?: ReadonlyArray<string>) => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-host-"));
	roots.push(root);
	const config = Effect.runSync(
		resolveJarvisConfig(
			Schema.decodeUnknownSync(JarvisLegacyConfig)({
				fathom: {
					...(selection === undefined ? {} : { poll_accounts: selection }),
					accounts: { research: {}, excluded: {}, personal: {} },
				},
			}),
		),
	);
	const paths = new JarvisPaths({
		targetDir: root,
		canonicalGlobalRoot: root,
		canonicalGlobalContextDir: root,
		canonicalProjectRoot: root,
		canonicalProjectContextDir: root,
		legacyGlobalRoot: root,
		legacyGlobalConfigFile: join(root, "config.yaml"),
		legacyGlobalContextDir: root,
		legacyProjectRoot: root,
		legacyProjectContextDir: root,
		legacyFallbackContextDir: root,
	});
	return { config, paths, inboxRoot: join(root, "inbox"), stateRoot: join(root, "state") };
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runConfiguredFathomPoll", () => {
	it("binds the selected accounts to injected credentials and a V2 store", async () => {
		const setup = fixture();
		const seen: string[] = [];
		const receipt = await runConfiguredFathomPoll({
			...setup,
			accounts: ["personal"],
			readApiKey: async (_config, _paths, account) => {
				seen.push(account);
				return "synthetic-key";
			},
			fetch: async (input, init) => {
				expect(String(input)).toContain("https://api.fathom.ai/external/v1/meetings");
				expect(new Headers(init?.headers).get("x-api-key")).toBe("synthetic-key");
				return new Response(JSON.stringify({ items: [{ recording_id: "1" }], next_cursor: null }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});
		expect(seen).toEqual(["personal"]);
		expect(receipt.accounts).toEqual(["personal"]);
		expect(receipt.results[0]?.imported).toBe(1);
	});
	it("uses configured scope and lets explicit selection override it without adding other accounts", async () => {
		for (const accounts of [undefined, ["personal"]]) {
			const setup = fixture(["research", "research"]);
			const selected: string[] = [];
			const receipt = await runConfiguredFathomPoll({
				...setup,
				accounts,
				readApiKey: async (_config, _paths, account) => {
					selected.push(account);
					return "synthetic";
				},
				fetch: async () => new Response(JSON.stringify({ items: [], next_cursor: null })),
			});
			expect(selected).toEqual(accounts ?? ["research"]);
			expect(receipt.accounts).toEqual(selected);
			expect(selected).not.toContain("excluded");
		}
	});
	it("rejects missing, empty and unknown scopes before credentials, networking or writes", async () => {
		for (const selection of [undefined, [], ["unknown"], ["research", "unknown"]]) {
			const setup = fixture(selection);
			let called = false;
			await expect(
				runConfiguredFathomPoll({
					...setup,
					readApiKey: async () => {
						called = true;
						throw new Error("unexpected credential access");
					},
					fetch: async () => {
						called = true;
						throw new Error("unexpected network");
					},
				}),
			).rejects.toThrow(/Fathom|fathom/);
			expect(called).toBe(false);
			expect(existsSync(setup.inboxRoot)).toBe(false);
			expect(existsSync(setup.stateRoot)).toBe(false);
		}
	});
	it("tags new notes by meeting-routes.yaml in the one folder, creates follow-ups once, and never polls an unselected account", async () => {
		const setup = fixture(["research"]);
		const privateRoot = join(setup.paths.targetDir, "private");
		for (const project of ["flow", "acme"]) mkdirSync(join(privateRoot, project, "meetings"), { recursive: true });
		writeFileSync(
			join(privateRoot, "meeting-routes.yaml"),
			"routes:\n  - project: acme\n    keywords: [acme pilot]\n",
		);
		const inboxRoot = join(privateRoot, "meeting-inbox", "fathom");
		const tasksFile = join(setup.paths.targetDir, "tasks.json");
		const recorded = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");
		const polled: string[] = [];
		const poll = () =>
			runConfiguredFathomPoll({
				...setup,
				inboxRoot,
				sourceRoot: join(privateRoot, "flow", "meetings"),
				followups: { tasksFile },
				readApiKey: async (_config, _paths, account) => {
					polled.push(account);
					return "synthetic";
				},
				fetch: async () =>
					new Response(
						JSON.stringify({
							items: [
								{
									recording_id: 701,
									meeting_title: "Acme pilot review",
									recording_start_time: recorded,
									created_at: recorded,
									share_url: "https://fathom.video/share/example-701",
									action_items: [
										{ description: "Draft the pilot terms", completed: false, assignee: { name: "Ada" } },
									],
								},
							],
							next_cursor: null,
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			});
		const first = await poll();
		expect(polled).toEqual(["research"]);
		expect(first.importedNotes?.notes.map((note) => note.project)).toEqual(["acme"]);
		const path = first.importedNotes!.paths[0]!;
		// The importer files by the recording's UTC date, so take the year from it.
		const year = String(new Date(recorded).getUTCFullYear());
		expect(path.startsWith(join(privateRoot, "flow", "meetings", year))).toBe(true);
		expect(readFileSync(path, "utf8")).toContain("- Project: acme\n");
		expect(readFileSync(path, "utf8")).toContain("- [ ] Draft the pilot terms (owner: Ada)");
		expect(first.followups).toMatchObject({ created: 1, existing: 0, queued: 0 });
		expect(first.tasksSync).toEqual({ state: "skipped", remaining: 0 });
		const second = await poll();
		expect(second.importedNotes).toMatchObject({ imported: 0, existing: 1 });
		expect(second.followups).toMatchObject({ created: 0, notes: 1, captured: 0, unchanged: 1 });
		const items = new TasksState(tasksFile).read().items;
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			kind: "followup",
			project: "acme",
			due: null,
			source: { kind: "meeting", path },
		});
	});
});
