import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
	type CommunityDraftProcessOptions,
	runCommunityDraftProcess,
} from "../src/jarvis/community-briefing/draft-process.ts";
import { runNativeCommunityDraft } from "../src/jarvis/community-briefing/native-draft.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = (withSource = false): CommunityDraftProcessOptions => {
	const pythonPath = process.env.HARNESSY_TEST_JARVIS_PYTHON;
	if (!pythonPath) throw new Error("Set HARNESSY_TEST_JARVIS_PYTHON to the isolated bootstrap-installed interpreter.");
	const root = mkdtempSync(join(tmpdir(), "community-parent-"));
	roots.push(root);
	const source = join(root, "sources");
	mkdirSync(source);
	if (withSource)
		writeFileSync(
			join(source, "flow.md"),
			"# Flow Research\n\n- Date: 2026-09-16\n\n## Key takeaways\n\nThe team reviewed the community learning materials and documented the next steps.\n",
		);
	return {
		runId: "fixture-run",
		pythonPath,
		config: {
			source_path: source,
			draft_path: join(root, "drafts"),
			state_path: join(root, "state"),
			timezone: "Africa/Lagos",
		},
		action: "generate",
		week_start: "2026-09-14",
		timeoutMs: 5000,
		signal: new AbortController().signal,
		generate: async () => {
			throw new Error("Unexpected provider call");
		},
	};
};
const rows = (options: CommunityDraftProcessOptions) => {
	const db = new DatabaseSync(join(options.config.state_path, "weekly-briefings.sqlite3"), { readOnly: true });
	try {
		return db.prepare("SELECT status,approved_hash,google_doc_id,discord_message_id FROM community_briefings").all();
	} finally {
		db.close();
	}
};

it("does not require credentials for a deterministic quiet native draft", async () => {
	const options = fixture();
	expect(
		await runNativeCommunityDraft({
			...options,
			authPath: join(options.config.source_path, "absent-auth"),
			model: "gpt-5.5",
			maximumOutputBytes: 65536,
		}),
	).toMatchObject({ status: "pending_review", provider_calls: 0 });
});

it("fails native generation without credentials and preserves consumption against replay", async () => {
	const options = fixture(true);
	const native = {
		...options,
		authPath: join(options.config.source_path, "absent-auth"),
		model: "gpt-5.5",
		maximumOutputBytes: 65536,
	};
	await expect(runNativeCommunityDraft(native)).rejects.toThrow("did not complete safely");
	await expect(runNativeCommunityDraft(native)).rejects.toThrow("did not complete safely");
	expect(rows(options)).toEqual([]);
	const db = new DatabaseSync(join(options.config.state_path, "weekly-briefings.sqlite3"), { readOnly: true });
	try {
		expect(db.prepare("SELECT calls FROM community_draft_runs").all()).toEqual([{ calls: 1 }]);
	} finally {
		db.close();
	}
});

it("composes the real installed quiet-week generator without provider access or publication", async () => {
	const options = fixture();
	expect(await runCommunityDraftProcess(options)).toMatchObject({
		status: "pending_review",
		provider_calls: 0,
		publication: false,
		notification_pending: true,
	});
	expect(rows(options)).toEqual([
		{ status: "pending_review", approved_hash: null, google_doc_id: null, discord_message_id: null },
	]);
	await expect(runCommunityDraftProcess(options)).rejects.toThrow("did not complete safely");
	expect(await runCommunityDraftProcess({ ...options, runId: "explicit-second-run" })).toMatchObject({
		existing: true,
		provider_calls: 0,
	});
});

it("hands a bounded classifier prompt to the parent and preserves its exclusion", async () => {
	const options = fixture(true);
	let calls = 0;
	const result = await runCommunityDraftProcess({
		...options,
		generate: async (prompt, sequence, signal) => {
			calls++;
			expect(sequence).toBe(1);
			expect(signal.aborted).toBe(false);
			expect(prompt).toContain("community learning materials");
			return {
				model: "synthetic-model",
				receiptId: "synthetic-receipt",
				text: JSON.stringify({
					decisions: [
						{
							source_id: createHash("sha256").update("flow.md").digest("hex").slice(0, 16),
							include: false,
							sensitivity: "private",
							facts: [],
						},
					],
				}),
			};
		},
	});
	expect(calls).toBe(1);
	expect(result).toMatchObject({ status: "pending_review", provider_calls: 1, publication: false });
});

it("retains provider receipts when generated JSON is invalid without retrying", async () => {
	const options = fixture(true);
	let calls = 0;
	await expect(
		runCommunityDraftProcess({
			...options,
			generate: async () => {
				calls++;
				return { text: "PRIVATE_INVALID_JSON", receiptId: "synthetic-response", model: "synthetic-model" };
			},
		}),
	).rejects.toThrow("did not complete safely");
	expect(calls).toBe(1);
	const db = new DatabaseSync(join(options.config.state_path, "weekly-briefings.sqlite3"), { readOnly: true });
	try {
		const row = db.prepare("SELECT status,receipts_json FROM community_draft_runs").get();
		expect(row?.status).toBe("failed");
		expect(String(row?.receipts_json)).not.toContain("PRIVATE_INVALID_JSON");
		expect(JSON.parse(String(row?.receipts_json))).toEqual([
			expect.objectContaining({
				receiptId: "synthetic-response",
				outputHash: createHash("sha256").update("PRIVATE_INVALID_JSON").digest("hex"),
			}),
		]);
	} finally {
		db.close();
	}
	expect(rows(options)).toEqual([]);
});

it("preserves failure without fallback and sanitizes provider errors", async () => {
	const options = fixture(true);
	let calls = 0;
	await expect(
		runCommunityDraftProcess({
			...options,
			generate: async () => {
				calls++;
				throw new Error("PRIVATE_SENTINEL");
			},
		}),
	).rejects.toThrow(/^Community draft did not complete safely/);
	expect(calls).toBe(1);
	expect(rows(options)).toEqual([]);
});

it("cancels an unresponsive provider callback and awaits child shutdown", async () => {
	const options = fixture(true);
	let observed: AbortSignal | undefined;
	const controller = new AbortController();
	await expect(
		runCommunityDraftProcess({
			...options,
			signal: controller.signal,
			generate: (_prompt, _sequence, signal) => {
				observed = signal;
				controller.abort();
				return new Promise(() => {});
			},
		}),
	).rejects.toThrow("did not complete safely");
	expect(observed?.aborted).toBe(true);
	expect(rows(options)).toEqual([]);
}, 2000);

it("handles an unavailable interpreter without leaving an unresolved child", async () => {
	const options = fixture();
	await expect(
		runCommunityDraftProcess({ ...options, pythonPath: join(options.config.source_path, "missing-python") }),
	).rejects.toThrow("did not complete safely");
});

it.each(["delivered", "unavailable", "throws"])(
	"records notification delivery only after confirmed submission: %s",
	async (outcome) => {
		const options = fixture();
		let calls = 0;
		const result = await runCommunityDraftProcess({
			...options,
			notify: async (kind, count, signal) => {
				calls++;
				expect(kind).toBe("pending");
				expect(count).toBe(1);
				expect(signal.aborted).toBe(false);
				if (outcome === "throws") throw new Error("PRIVATE_NOTIFICATION_ERROR");
				return outcome === "delivered";
			},
		});
		expect(calls).toBe(1);
		expect(result).toMatchObject({
			status: "pending_review",
			notification_pending: outcome !== "delivered",
			publication: false,
		});
		const db = new DatabaseSync(join(options.config.state_path, "weekly-briefings.sqlite3"), { readOnly: true });
		try {
			const row = db
				.prepare("SELECT last_notified_at,approved_hash,google_doc_id,discord_message_id FROM community_briefings")
				.get();
			expect(row).toMatchObject({ approved_hash: null, google_doc_id: null, discord_message_id: null });
			if (outcome === "delivered") expect(row?.last_notified_at).toEqual(expect.any(String));
			else expect(row?.last_notified_at).toBeNull();
		} finally {
			db.close();
		}
	},
);

it("stops an unresponsive notification without acknowledging delivery", async () => {
	const options = fixture();
	const controller = new AbortController();
	await expect(
		runCommunityDraftProcess({
			...options,
			signal: controller.signal,
			notify: async () => {
				controller.abort();
				return new Promise(() => {});
			},
		}),
	).rejects.toThrow("did not complete safely");
	const db = new DatabaseSync(join(options.config.state_path, "weekly-briefings.sqlite3"), { readOnly: true });
	try {
		expect(db.prepare("SELECT last_notified_at FROM community_briefings").get()).toEqual({ last_notified_at: null });
	} finally {
		db.close();
	}
});
