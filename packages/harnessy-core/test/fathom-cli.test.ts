import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { defaultLocalMeetingFile, defaultQueuePath } from "../src/jarvis/tasks/sync.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const suppliedCli = process.env.HARNESSY_FATHOM_TEST_CLI;
if (suppliedCli !== undefined && (!isAbsolute(suppliedCli) || !statSync(suppliedCli).isFile()))
	throw new Error("HARNESSY_FATHOM_TEST_CLI must be an existing absolute CLI file");
const cliEntry = suppliedCli === undefined ? join(packageRoot, "src", "cli.ts") : realpathSync(suppliedCli);

// Execute the actual command, real Effect services, file store and native fetch.
// The only transport seam rewrites the fixed production origin to our local server.
const run = async (
	failed: boolean,
	json: boolean,
	hostFailure = false,
	selection = "[personal, flowresearch]",
	accounts: readonly string[] = [],
) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-fathom-cli-")));
	const source = join(root, "source");
	mkdirSync(join(root, ".jarvis"), { recursive: true });
	mkdirSync(source);
	writeFileSync(
		join(root, ".jarvis", "config.yaml"),
		`fathom:\n${selection ? `  poll_accounts: ${selection}\n` : ""}  accounts:\n    personal:\n      api_key_env_var: SYNTHETIC_PERSONAL\n    flowresearch:\n      api_key_env_var: SYNTHETIC_FLOW\n    excluded:\n      api_key_env_var: MUST_NOT_READ\nmeeting_publication:\n  source_path: ${source}\n`,
	);
	if (hostFailure) {
		mkdirSync(join(source, "meeting-inbox", "fathom", "personal", "pending"), { recursive: true });
		writeFileSync(join(source, "meeting-inbox", "fathom", "personal", "pending", "malformed.json"), "null");
		// A regular file cannot serve as the canonical note directory.
		writeFileSync(join(source, String(new Date().getUTCFullYear())), "PRIVATE_HOST_ERROR_SENTINEL");
	}
	let requests = 0;
	const server = createServer((request, response) => {
		requests++;
		if (failed && request.headers["x-api-key"] === "synthetic-personal")
			response.writeHead(503).end("PRIVATE_BODY_SENTINEL");
		else
			response.end(
				JSON.stringify({
					items: hostFailure ? [{ recording_id: 42, created_at: new Date().toISOString() }] : [],
					limit: 20,
					next_cursor: "",
				}),
			);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("missing server address");
	const origin = `http://127.0.0.1:${address.port}`;
	const code = `
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== "https://api.fathom.ai") throw new Error("unexpected fixture destination");
  return nativeFetch(${JSON.stringify(origin)} + url.pathname + url.search, init);
};`;
	try {
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					"--experimental-strip-types",
					"--import",
					`data:text/javascript,${encodeURIComponent(code)}`,
					cliEntry,
					"jarvis",
					"meeting",
					"fathom",
					"poll",
					"--target",
					root,
					"--source-root",
					source,
					...accounts.flatMap((account) => ["--account", account]),
					...(json ? ["--json"] : []),
				],
				{
					cwd: packageRoot,
					env: {
						// Never reach the OS keychain from a test child.
						PI_AUTH_ENCRYPTION: "off",
						HSY_AUTH_ENCRYPTION: "off",
						HOME: root,
						NODE_NO_WARNINGS: "1",
						SYNTHETIC_PERSONAL: "synthetic-personal",
						SYNTHETIC_FLOW: "synthetic-flow",
					},
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 15000,
				},
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.once("error", reject);
			child.once("exit", (code, signal) =>
				signal ? reject(new Error(`child interrupted: ${signal}`)) : resolve({ code, stdout, stderr }),
			);
		});
		return { ...result, requests };
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
};

describe("actual Fathom CLI aggregate exit status", () => {
	it("uses explicit scheduler accounts when legacy configuration has no poll selection", async () => {
		const result = await run(false, true, false, "", ["personal", "flowresearch"]);
		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, accounts: ["personal", "flowresearch"] });
		expect(result.requests).toBe(2);
	});
	it.each(["", "[]", "[unknown]", "['../personal']"])(
		"rejects invalid account selection before provider traffic: %s",
		async (selection) => {
			const result = await run(false, true, false, selection);
			expect(result.code).toBe(1);
			expect(result.requests).toBe(0);
			expect(result.stdout + result.stderr).not.toContain("synthetic-personal");
		},
	);
	it("keeps all-success JSON and exit zero", async () => {
		const result = await run(false, true);
		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
		expect(result.requests).toBe(2);
	});
	it.each([true, false])("reports mixed account failure and exits nonzero (json=%s)", async (json) => {
		const result = await run(true, json);
		expect(result.code).toBe(1);
		expect(result.requests).toBe(2);
		if (json) {
			const receipt = JSON.parse(result.stdout);
			expect(receipt.ok).toBe(false);
			expect(receipt.results[0].failure.code).toBe("provider");
			expect(receipt.results[1].failure).toBeNull();
		} else expect(result.stdout).toContain("failed (provider)");
		expect(result.stdout + result.stderr).not.toContain("PRIVATE_BODY_SENTINEL");
		expect(result.stdout + result.stderr).not.toContain("synthetic-personal");
	});
	it("sanitizes a thrown note-import host failure and exits nonzero", async () => {
		const result = await run(false, true, true);
		expect(result.code).toBe(1);
		expect(result.stdout + result.stderr).toContain("Fathom poll host operation failed");
		expect(result.stdout + result.stderr).not.toContain("PRIVATE_HOST_ERROR_SENTINEL");
	});
});

// The poll command with task sync configured (a synthetic config under HOME) and a
// local fake task server that counts every request. The Fathom fixture lists one
// meeting with an action item and a summary step.
const runWithSync = async (flags: readonly string[]) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-fathom-cli-sync-")));
	const source = join(root, "source");
	mkdirSync(join(root, ".jarvis"), { recursive: true });
	mkdirSync(source);
	writeFileSync(
		join(root, ".jarvis", "config.yaml"),
		`fathom:\n  poll_accounts: [personal]\n  accounts:\n    personal:\n      api_key_env_var: SYNTHETIC_PERSONAL\nmeeting_publication:\n  source_path: ${source}\n`,
	);
	const tasksFile = join(root, ".harnessy", "portal", "tasks.json");
	const queuePath = defaultQueuePath(tasksFile);
	mkdirSync(join(root, ".harnessy", "portal"), { recursive: true });
	const pending = { op: "resolve", id: "00000000-0000-4000-8000-000000000001", note: "pre-filled" };
	writeFileSync(queuePath, JSON.stringify({ version: 1, items: [pending] }));
	const tokenFile = join(root, "tasks.token");
	writeFileSync(tokenFile, "synthetic-task-token\n", { mode: 0o600 });
	let taskRequests = 0;
	const tasks = createServer((_request, response) => {
		taskRequests++;
		response.writeHead(500).end("{}");
	});
	await new Promise<void>((resolve) => tasks.listen(0, "127.0.0.1", resolve));
	const taskAddress = tasks.address();
	if (taskAddress === null || typeof taskAddress === "string") throw new Error("missing server address");
	const taskOrigin = `http://127.0.0.1:${taskAddress.port}`;
	mkdirSync(join(root, ".config", "harnessy"), { recursive: true });
	writeFileSync(
		join(root, ".config", "harnessy", "tasks-sync.json"),
		JSON.stringify({ endpoint: taskOrigin, tokenFile }),
	);
	const started = new Date(Date.now() - 60 * 60 * 1000).toISOString();
	const fathom = createServer((_request, response) =>
		response.end(
			JSON.stringify({
				items: [
					{
						recording_id: 77,
						meeting_title: "Sync fixture",
						recording_start_time: started,
						created_at: started,
						share_url: "https://fathom.video/share/sync-fixture",
						action_items: [{ description: "Draft the pilot terms", assignee: { name: "Ada" }, completed: false }],
						default_summary: {
							markdown_formatted: "## Next Steps\n\n  - **Sam:** Book the venue for the offsite.\n",
						},
					},
				],
				limit: 20,
				next_cursor: "",
			}),
		),
	);
	await new Promise<void>((resolve) => fathom.listen(0, "127.0.0.1", resolve));
	const fathomAddress = fathom.address();
	if (fathomAddress === null || typeof fathomAddress === "string") throw new Error("missing server address");
	const fathomOrigin = `http://127.0.0.1:${fathomAddress.port}`;
	const code = `
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === ${JSON.stringify(taskOrigin)}) return nativeFetch(input, init);
  if (url.origin !== "https://api.fathom.ai") throw new Error("unexpected fixture destination");
  return nativeFetch(${JSON.stringify(fathomOrigin)} + url.pathname + url.search, init);
};`;
	try {
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					"--experimental-strip-types",
					"--import",
					`data:text/javascript,${encodeURIComponent(code)}`,
					cliEntry,
					"jarvis",
					"meeting",
					"fathom",
					"poll",
					"--target",
					root,
					"--source-root",
					source,
					"--json",
					...flags,
				],
				{
					cwd: packageRoot,
					env: {
						PI_AUTH_ENCRYPTION: "off",
						HSY_AUTH_ENCRYPTION: "off",
						HOME: root,
						NODE_NO_WARNINGS: "1",
						SYNTHETIC_PERSONAL: "synthetic-personal",
					},
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 15000,
				},
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.once("error", reject);
			child.once("exit", (exitCode, signal) =>
				signal ? reject(new Error(`child interrupted: ${signal}`)) : resolve({ code: exitCode, stdout, stderr }),
			);
		});
		const queue = JSON.parse(readFileSync(queuePath, "utf8")) as { items: unknown[] };
		const local = defaultLocalMeetingFile(tasksFile);
		return {
			...result,
			taskRequests,
			queue: queue.items,
			pending,
			tasksWritten: existsSync(tasksFile),
			localTitles: existsSync(local)
				? (JSON.parse(readFileSync(local, "utf8")) as { items: Array<{ title: string }> }).items.map(
						(item) => item.title,
					)
				: [],
		};
	} finally {
		for (const server of [tasks, fathom]) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		rmSync(root, { recursive: true, force: true });
	}
};

describe("actual Fathom CLI with task sync configured", () => {
	it("--dry-run sends no task request and leaves the queue as it was", async () => {
		const result = await runWithSync(["--dry-run"]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.taskRequests).toBe(0);
		expect(result.queue).toEqual([result.pending]);
		expect(result.tasksWritten).toBe(false);
		expect(JSON.parse(result.stdout).followups).toMatchObject({ dryRun: true, created: 2, queued: 0 });
	});
	it("--no-flush sends no task request and queues only the action item", async () => {
		const result = await runWithSync(["--no-flush"]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.taskRequests).toBe(0);
		expect(result.queue).toHaveLength(2);
		expect(result.queue[0]).toEqual(result.pending);
		expect(result.queue[1]).toMatchObject({ op: "ingestMeeting" });
		expect(JSON.stringify(result.queue)).toContain("Draft the pilot terms");
		expect(JSON.stringify(result.queue)).not.toContain("Book the venue");
		expect(result.localTitles).toEqual(["Book the venue for the offsite"]);
	});
});
