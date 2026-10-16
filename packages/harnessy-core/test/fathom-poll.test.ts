import { describe, expect, it } from "vitest";
import type { FathomIngestOptions } from "../src/jarvis/fathom/ingest.ts";
import { runFathomPoll } from "../src/jarvis/fathom/poll.ts";

const options = (account: string): Omit<FathomIngestOptions, "account"> => ({
	provider: {
		listMeetings: async () => ({ items: [{ recording_id: `${account}-1` }], nextCursor: null }),
	},
	store: {
		loadCheckpoint: async () => ({ cursor: null, seen: {}, updatedAt: null }),
		putPending: async () => "imported",
		saveCheckpoint: async () => undefined,
	},
});

describe("runFathomPoll", () => {
	it("rejects empty or unsafe selections before acquiring a provider", async () => {
		for (const accounts of [[], [""], ["../private"], ["valid", " "]]) {
			let acquired = false;
			await expect(
				runFathomPoll({
					accounts,
					createIngestOptions: (account) => {
						acquired = true;
						return options(account);
					},
				}),
			).rejects.toThrow("Select valid Fathom accounts");
			expect(acquired).toBe(false);
		}
	});

	it("runs one bounded pass for each explicitly selected account", async () => {
		const receipt = await runFathomPoll({
			accounts: ["personal", "flowresearch", "personal"],
			createIngestOptions: options,
		});
		expect(receipt.intervalSeconds).toBe(300);
		expect(receipt.accounts).toEqual(["personal", "flowresearch"]);
		expect(receipt.results.map((result) => result.account)).toEqual(["personal", "flowresearch"]);
		expect(receipt.results.every((result) => result.checkpointAdvanced)).toBe(true);
	});

	it("does not invent a retry when an account returns a provider failure", async () => {
		let calls = 0;
		const receipt = await runFathomPoll({
			accounts: ["personal", "flowresearch"],
			createIngestOptions: (account) => ({
				...options(account),
				provider: {
					listMeetings: async () => {
						calls += 1;
						if (account === "personal") throw new Error("offline");
						return { items: [], nextCursor: null };
					},
				},
			}),
		});
		expect(calls).toBe(2);
		expect(receipt.results[0]?.failure?.code).toBe("provider");
		expect(receipt.results[1]?.failure).toBeNull();
	});
});
