#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
	assertIsolatedRuntimeScope,
	assertNoSecretsInOutput,
	assertStrictCockpitCsp,
	signInCodeFromBrowserUrl,
	signInTargetFromOpenerArg,
} from "./cockpit-smoke-lib.mjs";

const COMMAND_TIMEOUT_MS = 90_000;
const MANIFEST_TIMEOUT_MS = 10_000;
const MAX_CAPTURED_OUTPUT = 50_000;
const POLL_INTERVAL_MS = 100;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const harnessyCli = join(repoRoot, "packages/harnessy-core/dist/cli.js");
const executorCli = join(repoRoot, "executor/apps/cli/src/main.ts");
const configuredHarnessyCli = process.env.HARNESSY_COCKPIT_CLI_JS?.trim();
const configuredExecutorCli = process.env.HARNESSY_COCKPIT_EXECUTOR_JS?.trim();
const smokeScope = resolve(process.env.HARNESSY_COCKPIT_SCOPE?.trim() || repoRoot);
const smokeLabel = process.env.HARNESSY_COCKPIT_LABEL?.trim() || "source";
const harnessyLaunch = {
	command: process.execPath,
	args: [configuredHarnessyCli || harnessyCli],
};
const executorLaunch = configuredExecutorCli
	? { command: process.execPath, args: [configuredExecutorCli] }
	: { command: "bun", args: ["run", executorCli] };

const redactSecrets = (value) =>
	value
		.replace(/([?&]_token=)[^\s&]+/g, "$1[redacted]")
		.replace(/([#&]_code=)[^\s&]+/g, "$1[redacted]")
		.replace(/("token"\s*:\s*")[^"]+"/g, '$1[redacted]"');

const wait = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const freeLoopbackPort = () =>
	new Promise((resolvePromise, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("Failed to allocate an ephemeral loopback port."));
				return;
			}
			server.close((error) => (error ? reject(error) : resolvePromise(address.port)));
		});
	});

const runCommand = (command, args, env, timeoutMillis = COMMAND_TIMEOUT_MS) =>
	new Promise((resolvePromise, reject) => {
		const useProcessGroup = process.platform !== "win32";
		const child = spawn(command, args, {
			cwd: smokeScope,
			detached: useProcessGroup,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let timedOut = false;
		let forceKillTimer;
		const capture = (chunk) => {
			output = `${output}${String(chunk)}`.slice(-MAX_CAPTURED_OUTPUT);
		};
		const signal = (name) => {
			if (child.pid === undefined) return;
			try {
				process.kill(useProcessGroup ? -child.pid : child.pid, name);
			} catch (error) {
				if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
			}
		};

		child.stdout.on("data", capture);
		child.stderr.on("data", capture);
		const timeout = setTimeout(() => {
			timedOut = true;
			signal("SIGTERM");
			forceKillTimer = setTimeout(() => signal("SIGKILL"), 3_000);
		}, timeoutMillis);

		child.once("error", (error) => {
			clearTimeout(timeout);
			clearTimeout(forceKillTimer);
			reject(error);
		});
		child.once("exit", (code, exitSignal) => {
			clearTimeout(timeout);
			if (!timedOut) clearTimeout(forceKillTimer);
			if (!timedOut && code === 0) {
				resolvePromise(output);
				return;
			}
			const status = timedOut
				? "timed out"
				: exitSignal === null
					? `exited with code ${code}`
					: `exited from signal ${exitSignal}`;
			reject(new Error(`Command ${status}.\n${redactSecrets(output)}`));
		});
	});

const readManifest = async (manifestPath) => {
	const raw = await readFile(manifestPath, "utf8");
	const manifest = JSON.parse(raw);
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!Number.isSafeInteger(manifest.pid) ||
		manifest.pid <= 1 ||
		manifest.pid === process.pid ||
		typeof manifest.dataDir !== "string" ||
		typeof manifest.scopeDir !== "string" ||
		typeof manifest.connection?.origin !== "string" ||
		manifest.connection.auth?.kind !== "bearer" ||
		typeof manifest.connection.auth.token !== "string" ||
		manifest.connection.auth.token === ""
	) {
		throw new Error("Executor wrote an invalid local server manifest.");
	}
	return manifest;
};

const waitForManifest = async (manifestPath) => {
	const deadline = Date.now() + MANIFEST_TIMEOUT_MS;
	let lastError;
	while (Date.now() < deadline) {
		try {
			return await readManifest(manifestPath);
		} catch (error) {
			lastError = error;
			await wait(POLL_INTERVAL_MS);
		}
	}
	throw new Error(`Executor did not publish a valid server manifest: ${String(lastError)}`);
};

const loopbackOrigin = (origin) => {
	const url = new URL(origin);
	if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
		throw new Error(`Executor advertised a non-loopback cockpit origin: ${origin}`);
	}
	return url.origin;
};

const attribute = (tag, name) => {
	const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
	return match?.[1] ?? match?.[2] ?? match?.[3];
};

const fetchWithTimeout = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });

const verifyAssets = async (origin, html) => {
	const tags = html.match(/<(?:script|link)\b[^>]*>/gi) ?? [];
	const assets = new Set();
	const modules = new Set();
	const stylesheets = new Set();
	for (const tag of tags) {
		const type = attribute(tag, "type");
		const relation = attribute(tag, "rel");
		const reference = attribute(tag, tag.toLowerCase().startsWith("<script") ? "src" : "href");
		if (reference === undefined) continue;
		const assetUrl = new URL(reference, origin);
		if (assetUrl.origin !== origin) continue;
		assets.add(assetUrl.href);
		if (type === "module") modules.add(assetUrl.href);
		if (relation === "stylesheet") stylesheets.add(assetUrl.href);
	}
	if (modules.size === 0 || stylesheets.size === 0) {
		throw new Error("Cockpit HTML is missing its built JavaScript or stylesheet assets.");
	}
	for (const assetUrl of assets) {
		const response = await fetchWithTimeout(assetUrl);
		if (!response.ok) throw new Error(`Cockpit asset ${new URL(assetUrl).pathname} failed with HTTP ${response.status}.`);
		const contentType = response.headers.get("content-type") ?? "";
		if (modules.has(assetUrl) && !contentType.includes("javascript")) {
			throw new Error(`Cockpit JavaScript asset has the wrong content type: ${contentType}.`);
		}
		if (stylesheets.has(assetUrl) && !contentType.includes("text/css")) {
			throw new Error(`Cockpit stylesheet has the wrong content type: ${contentType}.`);
		}
		await response.body?.cancel();
	}
};

const verifyAnytype = async (origin, token) => {
	const headers = { Authorization: `Bearer ${token}` };
	const integrationResponse = await fetchWithTimeout(`${origin}/api/openapi/integrations/anytype`, { headers });
	if (!integrationResponse.ok) {
		throw new Error(`Bundled AnyType lookup failed with HTTP ${integrationResponse.status}.`);
	}
	const integration = await integrationResponse.json();
	if (integration === null || integration.slug !== "anytype" || integration.kind !== "openapi") {
		throw new Error("Bundled AnyType integration is missing.");
	}

	const configResponse = await fetchWithTimeout(`${origin}/api/openapi/integrations/anytype/config`, { headers });
	if (!configResponse.ok) throw new Error(`Bundled AnyType config failed with HTTP ${configResponse.status}.`);
	const config = await configResponse.json();
	const apiKey = config?.authenticationTemplate?.find((method) => method.slug === "apiKey");
	const authorization = apiKey?.placements?.find(
		(placement) => placement.carrier === "header" && placement.name === "Authorization",
	);
	if (
		config?.baseUrl !== "http://127.0.0.1:31009" ||
		config?.headers?.["Anytype-Version"] !== "2025-11-08" ||
		apiKey?.kind !== "apikey" ||
		authorization?.prefix !== "Bearer " ||
		authorization?.variable !== "apiKey"
	) {
		throw new Error("Bundled AnyType integration has incomplete routing or authentication settings.");
	}
};

const readBrowserUrl = async (browserLog) => {
	const deadline = Date.now() + MANIFEST_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const lines = (await readFile(browserLog, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
		if (lines.length > 0) return lines.at(-1);
		await wait(POLL_INTERVAL_MS);
	}
	throw new Error("Harnessy did not open the cockpit in the browser.");
};

const collectLogs = async (root) => {
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	const logs = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".log"));
	return (await Promise.all(logs.map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")))).join("\n");
};

const expectMode = async (path, mode) => {
	const actual = (await stat(path)).mode & 0o777;
	if (actual !== mode) {
		throw new Error(`${path} has mode ${actual.toString(8)}; expected ${mode.toString(8)}.`);
	}
};

const verifyStatePermissions = async (dataDir) => {
	if (process.platform === "win32") return;
	await expectMode(dataDir, 0o700);
	await expectMode(join(dataDir, "server-control"), 0o700);
	await expectMode(join(dataDir, "server-control", "auth.json"), 0o600);
	await expectMode(join(dataDir, "server-control", "server.json"), 0o600);
};

const verifySignIn = async (origin, token, code) => {
	const exchange = () =>
		fetchWithTimeout(`${origin}/api/local-auth/exchange`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code }),
		});
	const first = await exchange();
	if (!first.ok || (await first.json())?.token !== token) {
		throw new Error(`Cockpit sign-in code exchange failed with HTTP ${first.status}.`);
	}
	const replay = await exchange();
	await replay.body?.cancel();
	if (replay.status !== 401) throw new Error(`A spent sign-in code was accepted again (HTTP ${replay.status}).`);
};

const verifyCors = async (origin) => {
	const port = Number(new URL(origin).port);
	const foreign = `http://127.0.0.1:${port === 65535 ? 65534 : port + 1}`;
	for (const [requestOrigin, expected] of [
		[origin, origin],
		[foreign, null],
		["https://evil.example", null],
	]) {
		const response = await fetchWithTimeout(`${origin}/api/health`, { headers: { origin: requestOrigin } });
		await response.body?.cancel();
		const allowed = response.headers.get("access-control-allow-origin");
		if (allowed !== expected) {
			throw new Error(`Cockpit CORS for ${requestOrigin} allowed ${allowed}; expected ${expected}.`);
		}
	}
};

const verifyCockpit = async ({ manifest, expectedDataDir, commandOutput, browserLog, temporaryRoot }) => {
	assertIsolatedRuntimeScope({
		manifest,
		expectedDataDir,
		expectedScopeDir: smokeScope,
		message: "Executor advertised the wrong data directory or workspace scope.",
	});
	const origin = loopbackOrigin(manifest.connection.origin);
	const token = manifest.connection.auth.token;
	if (!commandOutput.includes(`Opening ${origin}/`)) {
		throw new Error("Harnessy did not print the cockpit URL.");
	}
	const logs = await collectLogs(temporaryRoot);
	assertNoSecretsInOutput(`${commandOutput}\n${logs}`, [token], "Harnessy wrote the cockpit bearer token to its output or logs.");
	const openerArg = await readBrowserUrl(browserLog);
	if (!commandOutput.includes(`If no browser opened, open ${openerArg} within 60 seconds`)) {
		throw new Error("Harnessy did not print a manual sign-in fallback for headless hosts.");
	}
	const signInTarget = signInTargetFromOpenerArg(openerArg, join(expectedDataDir, "server-control"), [token]);
	const code = signInCodeFromBrowserUrl(signInTarget, origin);
	assertNoSecretsInOutput(commandOutput, [code], "Harnessy printed the one-time sign-in code.");
	await verifyStatePermissions(expectedDataDir);
	await verifySignIn(origin, token, code);
	await verifyCors(origin);

	const health = await fetchWithTimeout(`${origin}/api/health`);
	if (!health.ok || (await health.text()).trim() !== "ok") {
		throw new Error(`Cockpit health check failed with HTTP ${health.status}.`);
	}

	const page = await fetchWithTimeout(`${origin}/`);
	const contentType = page.headers.get("content-type") ?? "";
	const html = await page.text();
	if (!page.ok || !contentType.includes("text/html") || !/<title>\s*Harnessy\s*<\/title>/i.test(html)) {
		throw new Error(`Cockpit did not serve the built Harnessy HTML (HTTP ${page.status}, ${contentType}).`);
	}
	assertStrictCockpitCsp(page.headers.get("content-security-policy"));
	await verifyAssets(origin, html);
	await verifyAnytype(origin, token);
};

const isReachable = async (origin) => {
	const response = await fetchWithTimeout(`${origin}/api/health`).catch(() => undefined);
	if (response === undefined) return false;
	await response.body?.cancel();
	return true;
};

const signalPid = (pid, signal) => {
	try {
		process.kill(pid, signal);
	} catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
	}
};

const stopIsolatedDaemon = async (manifest, env) => {
	const origin = loopbackOrigin(manifest.connection.origin);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await runCommand(
			executorLaunch.command,
			[...executorLaunch.args, "daemon", "stop", "--base-url", origin],
			env,
			15_000,
		).catch(() => undefined);
		if (!(await isReachable(origin))) return;
		await wait(250);
	}

	signalPid(manifest.pid, "SIGTERM");
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (!(await isReachable(origin))) return;
		await wait(100);
	}
	signalPid(manifest.pid, "SIGKILL");
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (!(await isReachable(origin))) return;
		await wait(100);
	}
	throw new Error(`Isolated Executor daemon ${manifest.pid} did not stop.`);
};

const cleanupTemporaryRuntime = async (temporaryRoot, dataDir, manifest, env) => {
	try {
		if (manifest === undefined) return;
		assertIsolatedRuntimeScope({
			manifest,
			expectedDataDir: dataDir,
			expectedScopeDir: smokeScope,
			message: "Refusing to clean up a daemon outside the smoke-test scope.",
		});
		await stopIsolatedDaemon(manifest, env);
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
};

const main = async () => {
	if (process.argv.length !== 2) throw new Error("Usage: node scripts/check-harnessy-cockpit.mjs");
	const temporaryRoot = await mkdtemp(join(tmpdir(), `harnessy-cockpit-${smokeLabel}-`));
	const dataDir = join(temporaryRoot, "executor");
	const manifestPath = join(dataDir, "server-control", "server.json");
	const browserStubDir = join(temporaryRoot, "bin");
	await mkdir(browserStubDir, { recursive: true });
	const browserStub = join(browserStubDir, "xdg-open");
	// The stub records the argument the CLI hands the browser opener.
	const browserLog = join(temporaryRoot, "browser-urls.txt");
	const stubScript = `#!/bin/sh\nprintf '%s\\n' "$1" >> '${browserLog}'\nexit 0\n`;
	await writeFile(browserStub, stubScript, { mode: 0o755 });
	await writeFile(join(browserStubDir, "open"), stubScript, { mode: 0o755 });
	// A pre-existing, group/world-readable data directory must be repaired to 0700.
	await mkdir(dataDir, { recursive: true });
	await chmod(dataDir, 0o755);
	const env = {
		...process.env,
		BROWSER: browserStub,
		EXECUTOR_DATA_DIR: dataDir,
		EXECUTOR_SCOPE_DIR: smokeScope,
		HOME: temporaryRoot,
		PATH: `${browserStubDir}${delimiter}${process.env.PATH ?? ""}`,
		USERPROFILE: temporaryRoot,
		XDG_CONFIG_HOME: join(temporaryRoot, "config"),
		XDG_DATA_HOME: join(temporaryRoot, "share"),
		XDG_STATE_HOME: join(temporaryRoot, "state"),
	};
	delete env.HARNESSY_EXECUTOR_BIN;
	let manifest;

	try {
		const port = await freeLoopbackPort();
		const output = await runCommand(harnessyLaunch.command, [
			...harnessyLaunch.args,
			"web",
			"--port",
			String(port),
			"--data-dir",
			dataDir,
			"--scope",
			smokeScope,
		], env);
		manifest = await waitForManifest(manifestPath);
		await verifyCockpit({ manifest, expectedDataDir: dataDir, commandOutput: output, browserLog, temporaryRoot });
		console.log(`Harnessy ${smokeLabel} cockpit smoke passed.`);
	} finally {
		if (manifest === undefined) {
			try {
				manifest = await waitForManifest(manifestPath);
			} catch {
				// Startup can fail before Executor publishes its isolated manifest.
			}
		}
		await cleanupTemporaryRuntime(temporaryRoot, dataDir, manifest, env);
	}
};

main().catch((error) => {
	console.error(redactSecrets(error instanceof Error ? (error.stack ?? error.message) : String(error)));
	process.exitCode = 1;
});
