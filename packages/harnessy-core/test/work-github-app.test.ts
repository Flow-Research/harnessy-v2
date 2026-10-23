import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redactSecrets } from "../src/notifications/sanitize.ts";
import {
	AGENT_NAME,
	appJwt,
	basicAuthorization,
	botCachePath,
	botEmail,
	botUserId,
	commitIdentityEnv,
	createGitHubAuth,
	GitHubAppAuthError,
	type GitHubAppConfig,
	type GitHubFetch,
	ghEnv,
	githubRepoOf,
	gitPushEnv,
	KEYCHAIN_ACCOUNT,
	keychainService,
	loadPrivateKey,
	mintInstallationToken,
	operatorName,
	parseGitHubSettings,
	provenanceLines,
	readGitHubSettings,
	resolveGitHubApp,
	setUpGitHubApp,
	TOKEN_REFRESH_MS,
} from "../src/work/github-app.ts";
import { execRun, type Run, type RunResult } from "../src/work/run.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PEM_B64 = Buffer.from(PEM).toString("base64");
const PUBLIC = createPublicKey(privateKey);
const REPO = "flow/app";
const NOW = Date.parse("2026-10-23T12:00:00Z");
const ok = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "" });
const failed: RunResult = { exitCode: 1, stdout: "", stderr: "nope" };

const keychainConfig: GitHubAppConfig = {
	slug: "flow-research-agents",
	appId: 5443042,
	keySource: { kind: "keychain", service: keychainService("flow-research-agents"), account: KEYCHAIN_ACCOUNT },
};

interface FakeCall {
	readonly url: string;
	readonly method: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
}

/** A scripted GitHub API: each route answers with a status and a JSON body, or a thrown error. */
const fakeGitHub = (
	overrides: Partial<Record<string, { status: number; body?: unknown } | "throw" | "bad-json">> = {},
	tokenLifetimeMs = 60 * 60 * 1000,
	now: () => number = () => NOW,
) => {
	const calls: FakeCall[] = [];
	let minted = 0;
	const fetch: GitHubFetch = async (url, init) => {
		calls.push({
			url,
			method: init.method,
			headers: init.headers,
			...(init.body === undefined ? {} : { body: init.body }),
		});
		expect(init.redirect).toBe("error");
		const path = url.replace("https://api.github.com", "");
		const route = Object.keys(overrides).find((key) => path === key || path.startsWith(key));
		const override = route === undefined ? undefined : overrides[route];
		if (override === "throw") throw new Error("network down");
		if (override === "bad-json") return { status: 200, json: async () => Promise.reject(new Error("not json")) };
		if (override !== undefined) return { status: override.status, json: async () => override.body };
		if (path === "/repos/flow/app/installation") return { status: 200, json: async () => ({ id: 42 }) };
		if (path === "/app/installations/42/access_tokens") {
			minted++;
			return {
				status: 201,
				json: async () => ({
					token: `ghs_${String(minted).padStart(36, "x")}`,
					expires_at: new Date(now() + tokenLifetimeMs).toISOString(),
					repositories: [{ full_name: "Flow/App" }],
				}),
			};
		}
		if (path === "/users/flow-research-agents%5Bbot%5D") return { status: 200, json: async () => ({ id: 777 }) };
		return { status: 404, json: async () => ({}) };
	};
	return { calls, fetch, minted: () => minted };
};

const keychainRun =
	(result: RunResult = ok(`${PEM_B64}\n`)): Run =>
	async (argv) => {
		expect(argv).toEqual([
			"/usr/bin/security",
			"find-generic-password",
			"-s",
			"harnessy.github-app.flow-research-agents",
			"-a",
			"private-key-pem-base64",
			"-w",
		]);
		return result;
	};

const noFile = (): string => {
	throw new Error("no file reads expected");
};

describe("GitHub App settings", () => {
	it("reads nothing from a missing file and the fields from a full one", () => {
		expect(parseGitHubSettings(undefined)).toEqual({ app: {}, problems: [] });
		expect(parseGitHubSettings("{}")).toEqual({ app: {}, problems: [] });
		expect(parseGitHubSettings('{"github":[]}')).toEqual({ app: {}, problems: [] });
		expect(
			parseGitHubSettings(
				JSON.stringify({
					operator: "  Julian  ",
					github: {
						app: {
							slug: "flow-research-agents",
							id: "5443042",
							keySource: "file",
							keyFile: " /keys/app.pem ",
							botUserId: 777,
						},
					},
				}),
			),
		).toEqual({
			app: {
				slug: "flow-research-agents",
				id: 5443042,
				keySource: "file",
				keyFile: "/keys/app.pem",
				botUserId: 777,
			},
			operator: "Julian",
			problems: [],
			mayConfigureApp: true,
		});
	});

	it("marks a file that may configure an app, so its problems are not ignored", () => {
		expect(parseGitHubSettings('{"github":{"app":"flow"}}')).toEqual({
			app: {},
			problems: ["github.app must be an object"],
			mayConfigureApp: true,
		});
		expect(parseGitHubSettings('{"github": {"app": {').mayConfigureApp).toBe(true);
		expect(parseGitHubSettings("{").mayConfigureApp).toBeUndefined();
		expect(() =>
			resolveGitHubApp(undefined, parseGitHubSettings('{"github":{"app":{"slug":"Flow"}}}'), undefined, "darwin"),
		).toThrow("GitHub App settings: github.app.slug must be an app slug");
		expect(() => resolveGitHubApp(undefined, parseGitHubSettings('{"github": {'), undefined, "darwin")).toThrow(
			"not valid JSON",
		);
	});

	it("reports invalid values without repeating them", () => {
		expect(parseGitHubSettings("{")).toEqual({ app: {}, problems: ["the Harnessy settings file is not valid JSON"] });
		const read = parseGitHubSettings(
			JSON.stringify({
				operator: "a <b>",
				github: { app: { slug: "Bad Slug", id: -1, keySource: "vault", keyFile: " ", botUserId: 1.5 } },
			}),
		);
		expect(read.app).toEqual({});
		expect(read.problems).toEqual([
			"github.app.slug must be an app slug",
			"github.app.id must be a positive integer",
			"github.app.keySource must be keychain or file",
			"github.app.keyFile must be a file path",
			"github.app.botUserId must be a positive integer",
			"operator must be one line of 1 to 100 characters without angle brackets",
		]);
		expect(read.problems.join(" ")).not.toContain("Bad Slug");
	});

	it("accepts one-line operator names only", () => {
		expect(operatorName("Julian Duru\n")).toBe("Julian Duru");
		expect(operatorName("a\nb")).toBeUndefined();
		expect(operatorName("x".repeat(101))).toBeUndefined();
		expect(operatorName(7)).toBeUndefined();
		expect(operatorName("")).toBeUndefined();
	});

	it("reads the settings file, treating a missing one as empty", () => {
		const root = mkdtempSync(join(tmpdir(), "hsy-ghapp-settings-"));
		try {
			const path = join(root, "settings.json");
			expect(readGitHubSettings(path)).toEqual({ app: {}, problems: [] });
			writeFileSync(path, JSON.stringify({ github: { app: { slug: "flow-research-agents", id: 1 } } }));
			expect(readGitHubSettings(path).app).toEqual({ slug: "flow-research-agents", id: 1 });
			expect(
				readGitHubSettings(path, () => {
					throw Object.assign(new Error("denied"), { code: "EACCES" });
				}),
			).toEqual({ app: {}, problems: ["the Harnessy settings file could not be read"] });
			expect(
				readGitHubSettings(path, () => {
					throw "odd";
				}).problems,
			).toEqual(["the Harnessy settings file could not be read"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("resolveGitHubApp", () => {
	const settings = (app: object, operator?: string) =>
		parseGitHubSettings(JSON.stringify({ github: { app }, ...(operator === undefined ? {} : { operator }) }));

	it("is off without a flag or a configured slug", () => {
		expect(resolveGitHubApp(undefined, settings({ id: 1 }), undefined, "darwin")).toBeUndefined();
		// Problems in the settings file do not matter while the app is off.
		expect(resolveGitHubApp(undefined, parseGitHubSettings("{"), undefined, "darwin")).toBeUndefined();
	});

	it("uses the keychain by default on macOS", () => {
		expect(
			resolveGitHubApp("flow-research-agents", settings({ id: 5443042 }, "Julian"), undefined, "darwin"),
		).toEqual({
			...keychainConfig,
			operator: "Julian",
		});
		expect(
			resolveGitHubApp(
				undefined,
				settings({ slug: "flow-research-agents", id: 5443042, botUserId: 9 }),
				"  ",
				"darwin",
			),
		).toEqual({ ...keychainConfig, botUserId: 9 });
	});

	it("uses a key file from the environment or the settings", () => {
		expect(resolveGitHubApp("app", settings({ id: 1 }), "/env/key.pem", "linux")?.keySource).toEqual({
			kind: "file",
			path: "/env/key.pem",
		});
		expect(
			resolveGitHubApp("app", settings({ id: 1, keyFile: "/s/key.pem" }), undefined, "linux")?.keySource,
		).toEqual({
			kind: "file",
			path: "/s/key.pem",
		});
		expect(
			resolveGitHubApp("app", settings({ id: 1, keySource: "keychain", keyFile: "/s/key.pem" }), undefined, "darwin")
				?.keySource.kind,
		).toBe("keychain");
	});

	it("refuses configuration it cannot use", () => {
		const fails = (flag: string | undefined, read: ReturnType<typeof settings>, env?: string, platform = "darwin") =>
			expect(() => resolveGitHubApp(flag, read, env, platform));
		fails("Not A Slug", settings({ id: 1 })).toThrow("--github-app must be an app slug");
		fails("app", parseGitHubSettings("{")).toThrow("not valid JSON");
		fails("app", settings({ slug: "other", id: 1 })).toThrow("configures github.app for other");
		fails("app", settings({})).toThrow("set github.app.id");
		fails("app", settings({ id: 1 }), undefined, "linux").toThrow("set HSY_GITHUB_APP_KEY_FILE");
		fails("app", settings({ id: 1, keySource: "keychain" }), undefined, "linux").toThrow("only on macOS");
		fails("app", settings({ id: 1, keySource: "file" })).toThrow("no key file is named");
	});
});

describe("loadPrivateKey", () => {
	let root = "";
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "hsy-ghapp-key-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	const fromFile = (text: string) => {
		const path = join(root, "key.pem");
		writeFileSync(path, text);
		return loadPrivateKey(
			{ kind: "file", path },
			async () => failed,
			(file) => readFileSync(file, "utf8"),
		);
	};

	it("reads the base64 PEM from the keychain and registers it as a secret", async () => {
		const key = await loadPrivateKey(keychainConfig.keySource, keychainRun(), noFile);
		expect(key.asymmetricKeyType).toBe("rsa");
		expect(redactSecrets(`key ${PEM_B64} end`)).toBe("key <redacted> end");
		expect(redactSecrets(PEM)).toBe("<redacted>");
	});

	it("reads a PEM or base64 PEM file", async () => {
		expect((await fromFile(PEM)).type).toBe("private");
		expect((await fromFile(PEM_B64)).type).toBe("private");
	});

	it("fails with fixed text when the key is missing or unusable", async () => {
		await expect(loadPrivateKey(keychainConfig.keySource, keychainRun(failed), noFile)).rejects.toThrow(
			"the app's private key is not in the keychain (service harnessy.github-app.flow-research-agents, account private-key-pem-base64)",
		);
		await expect(
			loadPrivateKey({ kind: "file", path: join(root, "missing.pem") }, keychainRun(), (file) =>
				readFileSync(file, "utf8"),
			),
		).rejects.toThrow("the app's private key file could not be read");
		await expect(fromFile("hello world")).rejects.toThrow("is not a PEM private key");
		// Assembled at run time so the repository's secret scanner sees no key header.
		const label = ["RSA", "PRIVATE", "KEY"].join(" ");
		const broken = `-----BEGIN ${label}-----\nAAAA\n-----END ${label}-----\n`;
		const error = await fromFile(broken).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(GitHubAppAuthError);
		expect(String(error)).not.toContain("AAAA");
	});
});

const decode = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("appJwt", () => {
	it("signs an RS256 JWT issued a minute ago and valid for ten minutes", () => {
		const jwt = appJwt(5443042, privateKey, NOW + 999);
		const [header = "", payload = "", signature = ""] = jwt.split(".");
		expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
		const iat = NOW / 1000 - 60;
		expect(decode(payload)).toEqual({ iat, exp: iat + 600, iss: "5443042" });
		expect(verify("sha256", Buffer.from(`${header}.${payload}`), PUBLIC, Buffer.from(signature, "base64url"))).toBe(
			true,
		);
	});
});

describe("mintInstallationToken", () => {
	it("finds the installation and mints a token limited to the one repository", async () => {
		const github = fakeGitHub();
		const minted = await mintInstallationToken(github.fetch, 5443042, privateKey, REPO, NOW);
		expect(minted.token).toMatch(/^ghs_/u);
		expect(minted.expiresAt).toBe(NOW + 3_600_000);
		expect(github.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
			"GET https://api.github.com/repos/flow/app/installation",
			"POST https://api.github.com/app/installations/42/access_tokens",
		]);
		expect(JSON.parse(github.calls[1]?.body ?? "")).toEqual({ repositories: ["app"] });
		const jwt = github.calls[0]?.headers.authorization?.replace("Bearer ", "") ?? "";
		expect(github.calls[1]?.headers.authorization).toBe(`Bearer ${jwt}`);
		expect(github.calls[1]?.headers["content-type"]).toBe("application/json");
		expect(github.calls[0]?.headers["x-github-api-version"]).toBe("2022-11-28");
		// The JWT, the token and the git header value are all redacted from now on.
		expect(redactSecrets(`${jwt} ${minted.token} ${basicAuthorization(minted.token)}`)).toBe(
			"<redacted> <redacted> <redacted>",
		);
	});

	const mintFails = async (overrides: Parameters<typeof fakeGitHub>[0], message: string) => {
		const error = await mintInstallationToken(fakeGitHub(overrides).fetch, 1, privateKey, REPO, NOW).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(GitHubAppAuthError);
		expect((error as Error).message).toBe(message);
	};

	it("explains each failure with fixed text and the HTTP status", async () => {
		await mintFails({ "/repos/": "throw" }, "finding the app installation failed: GitHub could not be reached");
		await mintFails(
			{ "/repos/": { status: 401, body: { message: "secret detail" } } },
			"finding the app installation failed (HTTP 401): GitHub rejected the app JWT; check github.app.id and the private key",
		);
		await mintFails(
			{ "/repos/": { status: 404 } },
			"finding the app installation failed (HTTP 404): the app is not installed on flow/app",
		);
		await mintFails({ "/repos/": { status: 500 } }, "finding the app installation failed (HTTP 500)");
		await mintFails({ "/repos/": { status: 302 } }, "finding the app installation failed (HTTP 302)");
		await mintFails({ "/repos/": "bad-json" }, "finding the app installation returned no JSON");
		await mintFails({ "/repos/": { status: 200, body: { id: "x" } } }, "GitHub returned no installation id");
		await mintFails({ "/repos/": { status: 200, body: null } }, "GitHub returned no installation id");
		await mintFails(
			{ "/app/": { status: 422 } },
			"minting an installation token failed (HTTP 422): the installation cannot reach flow/app",
		);
	});

	it("refuses a token that is malformed or not limited to the repository", async () => {
		const expires = new Date(NOW + 3_600_000).toISOString();
		const token = `ghs_${"t".repeat(36)}`;
		const answer = (body: unknown) => ({ "/app/": { status: 201, body } });
		await mintFails(answer(null), "GitHub returned no usable installation token");
		await mintFails(answer({ token: "short", expires_at: expires }), "GitHub returned no usable installation token");
		await mintFails(answer({ token, expires_at: 5 }), "GitHub returned no usable installation token");
		await mintFails(answer({ token, expires_at: "soon" }), "GitHub returned no usable installation token");
		await mintFails(answer({ token, expires_at: expires }), "the minted token is not limited to flow/app");
		await mintFails(
			answer({ token, expires_at: expires, repositories: [{ full_name: "flow/app" }, { full_name: "flow/other" }] }),
			"the minted token is not limited to flow/app",
		);
		await mintFails(
			answer({ token, expires_at: expires, repositories: [{ full_name: "flow/other" }] }),
			"the minted token is not limited to flow/app",
		);
	});
});

describe("githubRepoOf", () => {
	it("reads owner/name from github.com remote URLs only", () => {
		expect(githubRepoOf("https://github.com/Flow-Research/harnessy-v2.git\n")).toBe("Flow-Research/harnessy-v2");
		expect(githubRepoOf("https://x-access-token@github.com/flow/app")).toBe("flow/app");
		expect(githubRepoOf("git@github.com:flow/app.git")).toBe("flow/app");
		expect(githubRepoOf("ssh://git@github.com:22/flow/app.git")).toBe("flow/app");
		expect(githubRepoOf("https://github.com/flow/app/")).toBe("flow/app");
		expect(githubRepoOf("https://gitlab.com/flow/app.git")).toBeUndefined();
		expect(githubRepoOf("https://github.com/flow/app/extra")).toBeUndefined();
		expect(githubRepoOf("")).toBeUndefined();
	});
});

describe("child environments", () => {
	it("gives git push the token only as an extra header, with no fallback credentials", () => {
		const token = `ghs_${"p".repeat(36)}`;
		const url = "https://github.com/flow/app.git";
		const env = gitPushEnv(token, url);
		expect(basicAuthorization(token)).toBe(`basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`);
		expect(env).toEqual({
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_COUNT: "4",
			GIT_CONFIG_KEY_0: `http.${url}.extraheader`,
			GIT_CONFIG_VALUE_0: "",
			GIT_CONFIG_KEY_1: `http.${url}.extraheader`,
			GIT_CONFIG_VALUE_1: `AUTHORIZATION: ${basicAuthorization(token)}`,
			GIT_CONFIG_KEY_2: "credential.helper",
			GIT_CONFIG_VALUE_2: "",
			GIT_CONFIG_KEY_3: `credential.${url}.helper`,
			GIT_CONFIG_VALUE_3: "",
			GIT_ALLOW_PROTOCOL: "https",
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "false",
			GIT_TRACE: "0",
			GIT_TRACE_CURL: "0",
			GIT_TRACE_PACKET: "0",
			GIT_CURL_VERBOSE: "0",
			GIT_TRACE_REDACT: "1",
			GH_DEBUG: "",
		});
		expect(ghEnv(token, REPO)).toEqual({
			GH_TOKEN: token,
			GH_HOST: "github.com",
			GH_REPO: REPO,
			GH_PROMPT_DISABLED: "1",
			GIT_TRACE: "0",
			GIT_TRACE_CURL: "0",
			GIT_TRACE_PACKET: "0",
			GIT_CURL_VERBOSE: "0",
			GIT_TRACE_REDACT: "1",
			GH_DEBUG: "",
		});
	});

	it("makes real git send only the app token, over a repository's own header and credential helper", async () => {
		const seen: Array<string | undefined> = [];
		const server = createServer((request, response) => {
			seen.push(request.headers.authorization);
			response.writeHead(401, { "www-authenticate": 'Basic realm="test"' }).end();
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const root = mkdtempSync(join(tmpdir(), "hsy-ghapp-git-"));
		try {
			const { port } = server.address() as AddressInfo;
			const url = `http://127.0.0.1:${port}/flow/app.git`;
			const git = (...args: string[]) => execRun(["git", "-C", root, ...args]);
			await git("init", "-q");
			// What actions/checkout writes, and a helper that would hand over the operator's password.
			await git("config", `http.http://127.0.0.1:${port}/.extraheader`, "AUTHORIZATION: basic T0xEOm9sZA==");
			await git("config", "http.extraheader", "AUTHORIZATION: basic R0VORVJJQzpvbGQ=");
			await git(
				"config",
				`credential.http://127.0.0.1:${port}.helper`,
				"!f() { echo username=op; echo password=leak; }; f",
			);
			await git("config", "credential.helper", "!f() { echo username=op; echo password=leak2; }; f");
			const token = `ghs_${"g".repeat(36)}`;
			// An operator who traces git with redaction off must still get no token in stderr.
			vi.stubEnv("GIT_TRACE_CURL", "1");
			vi.stubEnv("GIT_TRACE_REDACT", "0");
			const result = await execRun(["git", "-C", root, "ls-remote", url], {
				// Only so the test can use a local plain-HTTP server.
				env: {
					...gitPushEnv(token, url),
					GIT_ALLOW_PROTOCOL: "http",
					PI_AUTH_ENCRYPTION: "off",
					HSY_AUTH_ENCRYPTION: "off",
				},
			});
			expect(result.exitCode).not.toBe(0);
			expect(seen.length).toBeGreaterThan(0);
			expect(new Set(seen)).toEqual(new Set([basicAuthorization(token)]));
			const header = basicAuthorization(token).replace("basic ", "");
			const config = readFileSync(join(root, ".git", "config"), "utf8");
			for (const text of [result.stdout, result.stderr, config]) {
				expect(text).not.toContain(token);
				expect(text).not.toContain(header);
			}
		} finally {
			vi.unstubAllEnvs();
			server.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("names the agent and the operator on commits", () => {
		expect(botEmail(777, "flow-research-agents")).toBe("777+flow-research-agents[bot]@users.noreply.github.com");
		expect(commitIdentityEnv("Julian", 777, "flow-research-agents")).toEqual({
			GIT_AUTHOR_NAME: "Claude Code agent (operated by Julian)",
			GIT_AUTHOR_EMAIL: "777+flow-research-agents[bot]@users.noreply.github.com",
			GIT_COMMITTER_NAME: "Claude Code agent (operated by Julian)",
			GIT_COMMITTER_EMAIL: "777+flow-research-agents[bot]@users.noreply.github.com",
		});
		expect(provenanceLines("Julian", "t-1")).toEqual([
			`Agent: ${AGENT_NAME}`,
			"Operator: Julian",
			"WorkStream-Task: t-1",
		]);
	});
});

describe("createGitHubAuth", () => {
	it("mints once, reuses the token, and mints again when too little time remains", async () => {
		let clock = NOW;
		const github = fakeGitHub({}, 60 * 60 * 1000, () => clock);
		let keyLoads = 0;
		const auth = createGitHubAuth({
			config: keychainConfig,
			repo: REPO,
			run: async (argv, options) => {
				keyLoads++;
				return keychainRun()(argv, options);
			},
			fetch: github.fetch,
			readFile: noFile,
			now: () => clock,
		});
		expect(auth.pushUrl).toBe("https://github.com/flow/app.git");
		expect(auth.repo).toBe(REPO);
		const first = (await auth.ghEnv()).GH_TOKEN;
		expect((await auth.ghEnv()).GH_TOKEN).toBe(first);
		expect(github.minted()).toBe(1);
		// A 40-minute command needs a token that outlives it by the refresh margin: still fine at minute 5.
		clock += 5 * 60 * 1000;
		expect((await auth.ghEnv(40 * 60 * 1000)).GH_TOKEN).toBe(first);
		// At minute 15 it would not be: mint a fresh one.
		clock += 10 * 60 * 1000;
		const second = (await auth.ghEnv(40 * 60 * 1000)).GH_TOKEN;
		expect(second).not.toBe(first);
		// Less than the refresh margin left: mint again before a push.
		clock += 60 * 60 * 1000 - TOKEN_REFRESH_MS + 1;
		const push = await auth.pushEnv();
		expect(push.GIT_CONFIG_VALUE_1).not.toContain(second ?? "");
		expect(github.minted()).toBe(3);
		expect(keyLoads).toBe(3);
		expect(await auth.token()).toBe((await auth.ghEnv()).GH_TOKEN);
	});
});

describe("botUserId", () => {
	let root = "";
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "hsy-ghapp-bot-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	const read = (path: string) => readFileSync(path, "utf8");

	it("prefers the settings, then the cache, then GitHub, caching the answer", async () => {
		const github = fakeGitHub();
		const cache = botCachePath(join(root, "state"), "flow-research-agents");
		expect(cache).toBe(join(root, "state", "github-app", "flow-research-agents.json"));
		expect(await botUserId({ ...keychainConfig, botUserId: 5 }, cache, github.fetch, "tok", read)).toBe(5);
		expect(github.calls).toEqual([]);
		expect(await botUserId(keychainConfig, cache, github.fetch, "tok", read)).toBe(777);
		expect(github.calls.map(({ url }) => url)).toEqual([
			"https://api.github.com/users/flow-research-agents%5Bbot%5D",
		]);
		expect(github.calls[0]?.headers.authorization).toBe("Bearer tok");
		expect(JSON.parse(read(cache))).toEqual({ botUserId: 777 });
		expect(statSync(cache).mode & 0o777).toBe(0o600);
		expect(await botUserId(keychainConfig, cache, github.fetch, "tok", read)).toBe(777);
		expect(github.calls).toHaveLength(1);
	});

	it("looks up again when the cache is unusable, and survives a cache it cannot write", async () => {
		const cache = join(root, "cache.json");
		writeFileSync(cache, '{"botUserId":"x"}');
		const github = fakeGitHub();
		expect(await botUserId(keychainConfig, cache, github.fetch, "tok", read)).toBe(777);
		const blocked = join(root, "blocked");
		mkdirSync(blocked);
		chmodSync(blocked, 0o500);
		try {
			expect(await botUserId(keychainConfig, join(blocked, "sub", "c.json"), github.fetch, "tok", read)).toBe(777);
		} finally {
			chmodSync(blocked, 0o700);
		}
	});

	it("stops when GitHub has no such bot", async () => {
		const cache = join(root, "none.json");
		await expect(
			botUserId(keychainConfig, cache, fakeGitHub({ "/users/": { status: 404 } }).fetch, "tok", read),
		).rejects.toThrow(
			"looking up the app's bot user failed (HTTP 404): no bot user flow-research-agents[bot] exists",
		);
		await expect(
			botUserId(keychainConfig, cache, fakeGitHub({ "/users/": { status: 200, body: {} } }).fetch, "tok", read),
		).rejects.toThrow("GitHub returned no bot user id");
	});
});

describe("setUpGitHubApp", () => {
	let root = "";
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "hsy-ghapp-setup-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	const git =
		(origin: RunResult, userName: RunResult = ok("Julian Git\n")): Run =>
		async (argv, options) => {
			if (argv[0] === "/usr/bin/security") return keychainRun()(argv, options);
			if (argv.includes("get-url")) return origin;
			if (argv.includes("user.name")) return userName;
			throw new Error(`unexpected ${argv.join(" ")}`);
		};
	const setUp = (run: Run, config: GitHubAppConfig = keychainConfig, github = fakeGitHub()) =>
		setUpGitHubApp({
			config,
			repoPath: "/repo",
			task: "t-1",
			run,
			fetch: github.fetch,
			readFile: (path) => readFileSync(path, "utf8"),
			now: () => NOW,
			stateRoot: root,
		});

	it("proves the app works and prepares the identity, operator from git", async () => {
		const ready = await setUp(git(ok("git@github.com:flow/app.git\n")));
		expect(ready.operator).toBe("Julian Git");
		expect(ready.auth.repo).toBe(REPO);
		expect(ready.identity.GIT_AUTHOR_EMAIL).toBe("777+flow-research-agents[bot]@users.noreply.github.com");
		expect(ready.provenance).toEqual(["Agent: Claude Code", "Operator: Julian Git", "WorkStream-Task: t-1"]);
	});

	it("prefers the configured operator", async () => {
		const ready = await setUp(git(ok("https://github.com/flow/app.git"), failed), {
			...keychainConfig,
			operator: "Julian",
			botUserId: 3,
		});
		expect(ready.identity.GIT_AUTHOR_NAME).toBe("Claude Code agent (operated by Julian)");
	});

	it("stops when origin is not on github.com or no operator is known", async () => {
		await expect(setUp(git(failed))).rejects.toThrow("origin remote is not a github.com repository");
		await expect(setUp(git(ok("https://example.com/flow/app.git")))).rejects.toThrow("not a github.com repository");
		await expect(setUp(git(ok("https://github.com/flow/app.git"), failed))).rejects.toThrow("no operator name");
		await expect(setUp(git(ok("https://github.com/flow/app.git"), ok("<bad>\n")))).rejects.toThrow(
			"no operator name",
		);
		await expect(
			setUp(git(ok("https://github.com/flow/app.git")), keychainConfig, fakeGitHub({ "/repos/": { status: 404 } })),
		).rejects.toBeInstanceOf(GitHubAppAuthError);
	});
});
