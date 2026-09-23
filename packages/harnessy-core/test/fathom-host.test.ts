import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { JarvisLegacyConfig, resolveJarvisConfig } from "../src/jarvis/config-model.ts";
import { runConfiguredFathomPoll } from "../src/jarvis/fathom/host.ts";
import { JarvisPaths } from "../src/jarvis/paths.ts";

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
});
