import "../../harnessy-local-host/test/support/fixture-network-guard.mjs";

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { expect, it } from "vitest";
import { runNativeCommunityDraft, runNativeCommunityReview } from "../src/jarvis/community-briefing/native-draft.ts";

it.each(["draft", "review", "review-rejected", "excluded", "invalid-json", "rejected-credential"])(
	"runs the native community provider wire: %s",
	async (scenario) => {
		const pythonPath = process.env.HARNESSY_TEST_JARVIS_PYTHON;
		if (!pythonPath) throw new Error("Set HARNESSY_TEST_JARVIS_PYTHON to the isolated installed interpreter.");
		const root = realpathSync(mkdtempSync(join(tmpdir(), "community-native-wire-")));
		chmodSync(root, 0o700);
		const source = join(root, "sources");
		mkdirSync(source);
		writeFileSync(
			join(source, "flow.md"),
			"# Flow Research\n\n- Date: 2026-09-16\n\n## Key takeaways\n\nThe team reviewed the community learning materials and documented the next steps.\n",
		);
		const authPath = join(root, "auth.json");
		const payload = {
			exp: Math.floor(Date.now() / 1000) + 3600,
			"https://api.openai.com/auth": { chatgpt_account_id: "synthetic-community-account" },
		};
		const access = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`;
		writeFileSync(
			authPath,
			JSON.stringify({
				"openai-codex": {
					type: "oauth",
					access,
					refresh: "synthetic-unused",
					expires: Date.now() + 3600000,
					accountId: "synthetic-community-account",
				},
			}),
			{ mode: 0o600 },
		);
		const initialAuth = readFileSync(authPath);
		const reviews = scenario === "review" || scenario === "review-rejected";
		const writesDraft = scenario === "draft" || reviews;
		const output =
			scenario === "invalid-json"
				? "PRIVATE_INVALID_OUTPUT"
				: JSON.stringify({
						decisions: [
							{
								source_id: createHash("sha256").update("flow.md").digest("hex").slice(0, 16),
								include: writesDraft,
								sensitivity: writesDraft ? "public" : "private",
								facts: writesDraft ? ["The team reviewed the community learning materials."] : [],
							},
						],
					});
		const requests: { body: unknown; account: unknown; authorization: unknown }[] = [];
		const writerOutput = JSON.stringify({
			title: "We reviewed our community learning materials.",
			discord_summary: "We reviewed our community learning materials this week.",
			sections: Object.fromEntries(
				["This week in brief", "What moved", "What we learned", "What comes next", "How to take part"].map(
					(heading) => [
						heading,
						"We reviewed the community learning materials this week. We have no further verified public updates to share in this short briefing.",
					],
				),
			),
		});
		const revisionOutput = writerOutput.replace(
			"We reviewed our community learning materials.",
			"We clarified our community learning update.",
		);
		const server = createServer(async (incoming, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
			const bytes = Buffer.concat(chunks);
			requests.push({
				body: JSON.parse(
					(incoming.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes).toString(),
				),
				account: incoming.headers["chatgpt-account-id"],
				authorization: incoming.headers.authorization,
			});
			if (scenario === "rejected-credential" || (scenario === "review-rejected" && requests.length === 3)) {
				response.writeHead(401).end("PRIVATE_PROVIDER_ERROR");
				return;
			}
			const responseText = requests.length === 3 ? revisionOutput : requests.length === 2 ? writerOutput : output;
			const item = {
				type: "message",
				id: "msg_fixture",
				role: "assistant",
				content: [{ type: "output_text", text: responseText, annotations: [] }],
			};
			const events = [
				{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
				{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: responseText },
				{ type: "response.output_item.done", output_index: 0, item },
				{
					type: "response.completed",
					response: { id: `resp_community_fixture_${requests.length}`, status: "completed" },
				},
			];
			response.setHeader("Content-Type", "text/event-stream");
			response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing fixture port");
			const actual = openaiCodexProvider();
			const provider = {
				...actual,
				getModels: () =>
					actual.getModels().map((model) => ({ ...model, baseUrl: `http://127.0.0.1:${address.port}` })),
			};
			const options = {
				runId: "native-wire",
				pythonPath,
				authPath,
				model: "gpt-5.4-mini",
				maximumOutputBytes: 65536,
				config: {
					source_path: source,
					draft_path: join(root, "drafts"),
					state_path: join(root, "state"),
					timezone: "Africa/Lagos",
				},
				action: "generate" as const,
				week_start: "2026-09-14",
				timeoutMs: 5000,
				signal: new AbortController().signal,
			};
			const successful = scenario === "excluded" || writesDraft;
			const expectedCalls = writesDraft ? 2 : 1;
			if (successful) {
				expect(await runNativeCommunityDraft(options, provider)).toMatchObject({
					status: "pending_review",
					provider_calls: expectedCalls,
					publication: false,
				});
			} else {
				await expect(runNativeCommunityDraft(options, provider)).rejects.toThrow(
					/^Community draft did not complete safely/,
				);
			}
			await expect(runNativeCommunityDraft(options, provider)).rejects.toThrow("did not complete safely");
			expect(requests).toHaveLength(expectedCalls);
			expect(requests[0]).toMatchObject({
				account: "synthetic-community-account",
				authorization: `Bearer ${access}`,
				body: {
					model: options.model,
					tools: [],
					tool_choice: "none",
					parallel_tool_calls: false,
					store: false,
					stream: true,
				},
			});
			expect(readFileSync(authPath)).toEqual(initialAuth);
			if (reviews) {
				const controller = new AbortController();
				let ready: (url: string) => void = () => {};
				const readyPromise = new Promise<string>((resolve) => {
					ready = resolve;
				});
				let finished: (status: string) => void = () => {};
				const finishedPromise = new Promise<string>((resolve) => {
					finished = resolve;
				});
				const reviewing = runNativeCommunityReview(
					{
						...options,
						config: { ...options.config, review_port: 0 },
						operationTimeoutMs: 5000,
						signal: controller.signal,
						onReady: ready,
						onRunFinished: (result) => finished(result.status),
					},
					provider,
				).then(
					() => undefined,
					(error: unknown) => error,
				);
				try {
					const url = await Promise.race([
						readyPromise,
						reviewing.then(() => {
							throw new Error("Review exited before readiness");
						}),
					]);
					const login = await fetch(url);
					expect(login.status).toBe(200);
					const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
					await login.text();
					const state = new DatabaseSync(join(root, "state/weekly-briefings.sqlite3"), { readOnly: true });
					let item: Record<string, string | number | bigint | Uint8Array | null>;
					try {
						item = state.prepare("SELECT * FROM community_briefings").get()!;
					} finally {
						state.close();
					}
					const base = new URL(url).origin;
					const page = await (await fetch(`${base}/briefing/${item.briefing_id}`, { headers: { cookie } })).text();
					const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
					const response = await fetch(`${base}/briefing/revise/${item.briefing_id}`, {
						method: "POST",
						redirect: "manual",
						headers: { cookie },
						body: new URLSearchParams({
							csrf,
							revise_instruction: "Clarify the title.",
							revise_provider: "codex",
							briefing_markdown: readFileSync(String(item.briefing_path), "utf8"),
							discord_summary: readFileSync(String(item.discord_path), "utf8"),
						}),
					});
					expect(response.status).toBe(303);
					await response.text();
					expect(await finishedPromise).toBe(scenario === "review-rejected" ? "failed" : "completed");
					expect(requests).toHaveLength(3);
					expect(requests[2]).toMatchObject({
						account: "synthetic-community-account",
						authorization: `Bearer ${access}`,
						body: {
							model: options.model,
							tools: [],
							tool_choice: "none",
							parallel_tool_calls: false,
							store: false,
							stream: true,
						},
					});
					expect(JSON.stringify(requests[2].body)).toContain("Clarify the title");
					expect(readFileSync(String(item.briefing_path), "utf8")).toContain(
						scenario === "review-rejected"
							? "# We reviewed our community learning materials."
							: "# We clarified our community learning update.",
					);
					expect(readFileSync(authPath)).toEqual(initialAuth);
					const after = new DatabaseSync(join(root, "state/weekly-briefings.sqlite3"), { readOnly: true });
					try {
						after.exec("PRAGMA busy_timeout=2000");
						const run = after
							.prepare(
								"SELECT status,calls,receipts_json FROM community_draft_runs WHERE run_id != 'native-wire'",
							)
							.get()!;
						expect(run).toMatchObject({
							status: scenario === "review-rejected" ? "failed" : "completed",
							calls: 1,
						});
						expect(JSON.parse(String(run.receipts_json))).toEqual(
							scenario === "review-rejected"
								? []
								: [
										expect.objectContaining({
											sequence: 1,
											receiptId: "resp_community_fixture_3",
											outputHash: createHash("sha256").update(revisionOutput).digest("hex"),
										}),
									],
						);
					} finally {
						after.close();
					}
				} finally {
					controller.abort();
					await reviewing;
				}
				expect(await reviewing).toBeUndefined();
			}
			const db = new DatabaseSync(join(root, "state", "weekly-briefings.sqlite3"), { readOnly: true });
			try {
				const run = db
					.prepare("SELECT calls,receipts_json FROM community_draft_runs WHERE run_id='native-wire'")
					.get();
				expect(run?.calls).toBe(expectedCalls);
				const receipts = JSON.parse(String(run?.receipts_json));
				expect(receipts).toHaveLength(scenario === "rejected-credential" ? 0 : expectedCalls);
				if (scenario !== "rejected-credential")
					expect(receipts[0]).toMatchObject({
						receiptId: "resp_community_fixture_1",
						outputHash: createHash("sha256").update(output).digest("hex"),
					});
				const queue = db
					.prepare("SELECT status,approved_hash,google_doc_id,discord_message_id FROM community_briefings")
					.all();
				expect(queue).toEqual(
					successful
						? [{ status: "pending_review", approved_hash: null, google_doc_id: null, discord_message_id: null }]
						: [],
				);
				if (scenario === "draft") {
					expect(receipts[1]).toMatchObject({
						sequence: 2,
						receiptId: "resp_community_fixture_2",
						outputHash: createHash("sha256").update(writerOutput).digest("hex"),
					});
					const artifact = db.prepare("SELECT briefing_path FROM community_briefings").get();
					expect(readFileSync(String(artifact?.briefing_path), "utf8")).toContain(
						"# We reviewed our community learning materials.",
					);
				}
			} finally {
				db.close();
			}
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		}
	},
);
