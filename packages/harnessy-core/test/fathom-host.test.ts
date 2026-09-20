import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { runConfiguredFathomPoll } from "../src/jarvis/fathom/host.ts";

const config = {} as never;
const paths = {} as never;

describe("runConfiguredFathomPoll", () => {
	it("binds the selected accounts to injected credentials and a V2 store", async () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-host-"));
		const seen: string[] = [];
		const receipt = await runConfiguredFathomPoll({
			config,
			paths,
			inboxRoot: join(root, "inbox"),
			stateRoot: join(root, "state"),
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
});
