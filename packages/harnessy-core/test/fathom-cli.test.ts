import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const suppliedCli = process.env.HARNESSY_FATHOM_TEST_CLI;
if (suppliedCli !== undefined && (!isAbsolute(suppliedCli) || !statSync(suppliedCli).isFile()))
	throw new Error("HARNESSY_FATHOM_TEST_CLI must be an existing absolute CLI file");
const cliEntry = suppliedCli === undefined ? join(packageRoot, "src", "cli.ts") : realpathSync(suppliedCli);

// Execute the actual command, real Effect services, file store and native fetch.
// The only transport seam rewrites the fixed production origin to our local server.
const run = async (failed: boolean, json: boolean, hostFailure = false) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-fathom-cli-")));
	const source = join(root, "source");
	mkdirSync(join(root, ".jarvis"), { recursive: true });
	mkdirSync(source);
	writeFileSync(
		join(root, ".jarvis", "config.yaml"),
		`fathom:\n  accounts:\n    personal:\n      api_key_env_var: SYNTHETIC_PERSONAL\n    flowresearch:\n      api_key_env_var: SYNTHETIC_FLOW\nmeeting_publication:\n  source_path: ${source}\n`,
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
					...(json ? ["--json"] : []),
				],
				{
					cwd: packageRoot,
					env: {
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
