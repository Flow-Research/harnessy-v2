import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
	darwinProcessExecutableFromLsof,
	isNativeCommunityReviewProcess,
} from "../src/jarvis/community-briefing/operational-runtime.ts";

const suppliedCli = process.env.HARNESSY_COMMUNITY_TEST_CLI;
if (suppliedCli !== undefined && (!isAbsolute(suppliedCli) || !existsSync(suppliedCli)))
	throw new Error("HARNESSY_COMMUNITY_TEST_CLI must identify an installed absolute CLI file.");

it.each(["configured", "override"])(
	"runs community generation and native review with %s interpreter without publication",
	async (mode) => {
		const python = process.env.HARNESSY_TEST_JARVIS_PYTHON;
		if (!python) throw new Error("Set HARNESSY_TEST_JARVIS_PYTHON to the isolated installed interpreter.");
		const root = realpathSync(mkdtempSync(join(tmpdir(), "community-cli-")));
		try {
			mkdirSync(join(root, "sources"));
			const config = join(root, "config.yaml");
			writeFileSync(
				config,
				JSON.stringify({
					community_briefing: {
						python_path: python,
						source_path: "sources",
						draft_path: "drafts",
						state_path: "state",
						timezone: "Africa/Lagos",
						max_sources: 10,
					},
				}),
				{ mode: 0o600 },
			);
			const before = readFileSync(config);
			const run = (extra: string[] = []) =>
				spawnSync(
					process.execPath,
					[
						"--experimental-strip-types",
						"--import",
						fileURLToPath(
							new URL("../../harnessy-local-host/test/support/fixture-network-guard.mjs", import.meta.url),
						),
						suppliedCli ?? fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
						"jarvis",
						"community",
						"briefing",
						"generate",
						"--notifications",
						"off",
						"--config",
						config,
						"--week-start",
						"2026-09-14",
						"--run-id",
						"cli-run",
						...extra,
					],
					{ cwd: root, env: { HOME: root, NODE_NO_WARNINGS: "1" }, encoding: "utf8", timeout: 15000 },
				);
			const configured = JSON.parse(before.toString());
			for (const pythonPath of [undefined, "relative-python"]) {
				writeFileSync(
					config,
					JSON.stringify({ community_briefing: { ...configured.community_briefing, python_path: pythonPath } }),
				);
				const invalidRuntime = run();
				expect(invalidRuntime.status).not.toBe(0);
				expect(invalidRuntime.stderr).toContain("community_briefing.python_path");
				expect(existsSync(join(root, "state"))).toBe(false);
			}
			// An explicit override works even when the configured path is invalid.
			if (mode === "configured") writeFileSync(config, before);
			const result = run(mode === "override" ? ["--python-path", python] : []);
			writeFileSync(config, before);
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({
				runId: "cli-run",
				status: "pending_review",
				publication: false,
				provider_calls: 0,
				notification_pending: true,
			});
			expect(readFileSync(config)).toEqual(before);
			expect(existsSync(join(root, ".hsy"))).toBe(false);
			const replay = run();
			expect(replay.status).not.toBe(0);
			expect(replay.stdout).not.toContain('"publication": false');
			const db = new DatabaseSync(join(root, "state", "weekly-briefings.sqlite3"), { readOnly: true });
			try {
				expect(
					db
						.prepare("SELECT status,approved_hash,google_doc_id,discord_message_id FROM community_briefings")
						.all(),
				).toEqual([
					{ status: "pending_review", approved_hash: null, google_doc_id: null, discord_message_id: null },
				]);
				expect(db.prepare("SELECT calls FROM community_draft_runs").all()).toEqual([{ calls: 0 }]);
			} finally {
				db.close();
			}
			const reviewer = spawn(
				process.execPath,
				[
					...(suppliedCli ? [] : ["--experimental-strip-types"]),
					suppliedCli ?? fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
					"jarvis",
					"community",
					"briefing",
					"review",
					"serve",
					"--config",
					config,
					"--port",
					"0",
					"--notifications",
					"off",
				],
				{
					cwd: root,
					env: {
						HOME: root,
						NODE_NO_WARNINGS: "1",
						NODE_OPTIONS: `--import=${new URL("../../harnessy-local-host/test/support/fixture-network-guard.mjs", import.meta.url).href}`,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			const closed = new Promise<number | null>((resolve) => reviewer.once("close", resolve));
			let diagnostics = "";
			reviewer.stderr.on("data", (chunk: Buffer) => {
				diagnostics += chunk.toString();
			});
			const lines = createInterface({ input: reviewer.stdout, crlfDelay: Infinity });
			const iterator = lines[Symbol.asyncIterator]();
			const next = async () => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const entry = await Promise.race([
						iterator.next(),
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(new Error(`CLI event timed out: ${diagnostics}`)), 10000);
						}),
					]);
					expect(entry.done, diagnostics).toBe(false);
					return JSON.parse(entry.value!);
				} finally {
					clearTimeout(timer);
				}
			};
			let reviewUrl: string | undefined;
			let forced = false;
			try {
				const ready = await next();
				expect(ready).toMatchObject({ event: "ready", publication: false });
				reviewUrl = ready.reviewUrl;
				if (suppliedCli) {
					const command = spawnSync("/bin/ps", ["-p", String(reviewer.pid), "-o", "command="], {
						encoding: "utf8",
						timeout: 2000,
					});
					const executable = spawnSync("/bin/ps", ["-p", String(reviewer.pid), "-o", "comm="], {
						encoding: "utf8",
						timeout: 2000,
					});
					const processExecutable =
						process.platform === "linux"
							? `/proc/${reviewer.pid}/exe`
							: darwinProcessExecutableFromLsof(
									spawnSync("/usr/sbin/lsof", ["-a", "-p", String(reviewer.pid), "-d", "txt", "-F0pfn"], {
										encoding: "utf8",
										timeout: 2000,
										maxBuffer: 1_000_000,
									}).stdout,
									reviewer.pid!,
								);
					expect(command.status).toBe(0);
					expect(executable.status).toBe(0);
					expect(processExecutable).toBeDefined();
					expect(
						isNativeCommunityReviewProcess(
							command.stdout.trim(),
							executable.stdout.trim(),
							processExecutable!,
							process.execPath,
							suppliedCli,
						),
					).toBe(true);
				}
				const login = await fetch(reviewUrl!);
				expect(login.status).toBe(200);
				const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
				await login.text();
				const base = new URL(reviewUrl!).origin;
				const itemId = JSON.parse(result.stdout).briefing_id;
				const page = await (await fetch(`${base}/briefing/${itemId}`, { headers: { cookie } })).text();
				const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
				const state = new DatabaseSync(join(root, "state/weekly-briefings.sqlite3"), { readOnly: true });
				let fields: URLSearchParams;
				try {
					state.exec("PRAGMA busy_timeout=2000");
					const item = state.prepare("SELECT briefing_path,discord_path FROM community_briefings").get()!;
					fields = new URLSearchParams({
						csrf,
						revise_instruction: "Clarify the update.",
						revise_provider: "codex",
						briefing_markdown: readFileSync(String(item.briefing_path), "utf8"),
						discord_summary: readFileSync(String(item.discord_path), "utf8"),
					});
				} finally {
					state.close();
				}
				const revision = await fetch(`${base}/briefing/revise/${itemId}`, {
					method: "POST",
					body: fields,
					headers: { cookie },
					redirect: "manual",
				});
				expect(revision.status).toBe(303);
				await revision.text();
				expect(await next()).toMatchObject({
					event: "draft-finished",
					status: "failed",
					calls: 1,
					publication: false,
					notificationDelivered: false,
				});
				const approve = await fetch(`${base}/briefing/approve/${itemId}`, {
					method: "POST",
					body: fields,
					headers: { cookie },
					redirect: "manual",
				});
				expect(approve.status).toBe(303);
				await approve.text();
				const verified = new DatabaseSync(join(root, "state/weekly-briefings.sqlite3"), { readOnly: true });
				try {
					verified.exec("PRAGMA busy_timeout=2000");
					expect(
						verified
							.prepare(
								"SELECT status,approved_hash=draft_hash AS exact,google_doc_id,discord_message_id FROM community_briefings",
							)
							.get(),
					).toEqual({ status: "approved", exact: 1, google_doc_id: null, discord_message_id: null });
				} finally {
					verified.close();
				}
				expect(readFileSync(config)).toEqual(before);
			} finally {
				reviewer.kill("SIGTERM");
				const force = setTimeout(() => {
					forced = true;
					reviewer.kill("SIGKILL");
				}, 5000);
				await closed;
				clearTimeout(force);
				lines.close();
			}
			expect(forced, "review CLI must stop without forced cleanup").toBe(false);
			if (reviewUrl) await expect(fetch(reviewUrl)).rejects.toThrow();
			writeFileSync(config, "community_briefing: [INVALID]");
			const invalid = run();
			expect(invalid.status).not.toBe(0);
			expect(invalid.stderr).not.toContain("INVALID");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	30000,
);
