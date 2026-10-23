import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as Result from "effect/Result";
import { registerSecret } from "../notifications/sanitize.ts";
import type { Run } from "./run.ts";

/**
 * `harnessy work --github-app <slug>`: Harnessy's own pushes and `gh` calls
 * authenticate as a GitHub App installation instead of the operator's
 * account. The agent never sees the key or a token: they live only in this
 * process's memory and in the environment of the one child that needs them.
 */

export const GITHUB_API = "https://api.github.com";
/** Keychain account that holds the base64 of the app's PEM private key. */
export const KEYCHAIN_ACCOUNT = "private-key-pem-base64";
export const keychainService = (slug: string): string => `harnessy.github-app.${slug}`;
/** The agent Harnessy runs, as it appears in commit trailers and the PR body. */
export const AGENT_NAME = "Claude Code";
/** A token with less than this left is replaced before the next GitHub step. */
export const TOKEN_REFRESH_MS = 10 * 60 * 1000;
const API_TIMEOUT_MS = 20 * 1000;
const KEYCHAIN_TIMEOUT_MS = 30 * 1000;

/** A failure to authenticate as the app: the run stops with `github_app_auth_failed`, never falls back. */
export class GitHubAppAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GitHubAppAuthError";
	}
}

/** The subset of `fetch` the GitHub API calls use; tests pass a fake. */
export type GitHubFetch = (
	url: string,
	init: {
		readonly method: "GET" | "POST";
		readonly headers: Readonly<Record<string, string>>;
		readonly body?: string;
		readonly signal: AbortSignal;
		readonly redirect: "error";
	},
) => Promise<{ readonly status: number; readonly json: () => Promise<unknown> }>;

/** `github.app` in Harnessy's settings file. */
export interface GitHubAppSettings {
	readonly slug?: string;
	readonly id?: number;
	readonly keySource?: "keychain" | "file";
	readonly keyFile?: string;
	readonly botUserId?: number;
}

/** What the settings file says about the app and the operator, plus anything it got wrong. */
export interface GitHubSettingsRead {
	readonly app: GitHubAppSettings;
	readonly operator?: string;
	/** Fixed text without values. They matter only when the app is used. */
	readonly problems: ReadonlyArray<string>;
	/**
	 * The file may configure an app: it has a `github.app` key, or it could
	 * not be parsed although it mentions `github`. Problems then stop the run
	 * instead of silently switching the app off.
	 */
	readonly mayConfigureApp?: boolean;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u;
/** One line a git identity and a PR body can carry: no control characters or angle brackets. */
const OPERATOR = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]{1,100}$/u;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const positiveInteger = (value: unknown): number | undefined => {
	const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
	return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

/** A valid operator name, trimmed, or undefined. */
export const operatorName = (value: unknown): string | undefined => {
	const name = typeof value === "string" ? value.trim() : "";
	return OPERATOR.test(name) ? name : undefined;
};

/** Parse the `github.app` and `operator` keys of the settings file's text; undefined text means no file. */
export const parseGitHubSettings = (text: string | undefined): GitHubSettingsRead => {
	if (text === undefined) return { app: {}, problems: [] };
	const parsed = Result.try((): unknown => JSON.parse(text));
	if (Result.isFailure(parsed))
		return {
			app: {},
			problems: ["the Harnessy settings file is not valid JSON"],
			...(text.includes('"github"') ? { mayConfigureApp: true } : {}),
		};
	const root = record(parsed.success);
	const rawApp = record(root?.github)?.app;
	const app = record(rawApp) ?? {};
	const problems: string[] = [];
	if (rawApp !== undefined && record(rawApp) === undefined) problems.push("github.app must be an object");
	const check = <T>(key: string, value: T | undefined, rule: string): T | undefined => {
		if (app[key] !== undefined && value === undefined) problems.push(`github.app.${key} ${rule}`);
		return value;
	};
	const slug = check(
		"slug",
		typeof app.slug === "string" && SLUG.test(app.slug) ? app.slug : undefined,
		"must be an app slug",
	);
	const id = check("id", positiveInteger(app.id), "must be a positive integer");
	const keySource = check(
		"keySource",
		app.keySource === "keychain" || app.keySource === "file" ? app.keySource : undefined,
		"must be keychain or file",
	);
	const keyFile = check(
		"keyFile",
		typeof app.keyFile === "string" && app.keyFile.trim() !== "" ? app.keyFile.trim() : undefined,
		"must be a file path",
	);
	const botUserId = check("botUserId", positiveInteger(app.botUserId), "must be a positive integer");
	const operator = operatorName(root?.operator);
	if (root?.operator !== undefined && operator === undefined)
		problems.push("operator must be one line of 1 to 100 characters without angle brackets");
	return {
		app: {
			...(slug === undefined ? {} : { slug }),
			...(id === undefined ? {} : { id }),
			...(keySource === undefined ? {} : { keySource }),
			...(keyFile === undefined ? {} : { keyFile }),
			...(botUserId === undefined ? {} : { botUserId }),
		},
		...(operator === undefined ? {} : { operator }),
		problems,
		...(rawApp === undefined ? {} : { mayConfigureApp: true }),
	};
};

/** Read the settings file; a missing file is no settings, an unreadable one a problem. */
export const readGitHubSettings = (
	path: string,
	read: (path: string) => string = (file) => readFileSync(file, "utf8"),
): GitHubSettingsRead => {
	const raw = Result.try(() => read(path));
	if (Result.isSuccess(raw)) return parseGitHubSettings(raw.success);
	const error = raw.failure;
	const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
	return missing
		? parseGitHubSettings(undefined)
		: { app: {}, problems: ["the Harnessy settings file could not be read"] };
};

export type KeySource =
	| { readonly kind: "keychain"; readonly service: string; readonly account: string }
	| { readonly kind: "file"; readonly path: string };

/** A usable app configuration. */
export interface GitHubAppConfig {
	readonly slug: string;
	readonly appId: number;
	readonly keySource: KeySource;
	readonly operator?: string;
	readonly botUserId?: number;
}

/**
 * The app to use, or undefined for the operator's own `gh` and git
 * credentials. The `--github-app` flag or `github.app.slug` turns it on;
 * the app id always comes from the settings file. The key comes from the
 * file `HSY_GITHUB_APP_KEY_FILE` or `github.app.keyFile` names, else from
 * the macOS keychain. Throws on configuration it cannot use, before
 * anything has happened.
 */
export const resolveGitHubApp = (
	flagSlug: string | undefined,
	read: GitHubSettingsRead,
	keyFileEnv: string | undefined,
	platform: string,
): GitHubAppConfig | undefined => {
	const slug = flagSlug ?? read.app.slug;
	// A broken app entry must not quietly mean "push as the operator".
	if (slug === undefined && read.mayConfigureApp === true && read.problems.length > 0)
		throw new Error(`GitHub App settings: ${read.problems.join("; ")}`);
	if (slug === undefined) return undefined;
	const fail = (problem: string) => {
		throw new Error(`GitHub App ${slug}: ${problem}`);
	};
	if (!SLUG.test(slug)) fail("--github-app must be an app slug such as flow-research-agents");
	if (read.problems.length > 0) fail(read.problems.join("; "));
	if (read.app.slug !== undefined && read.app.slug !== slug)
		fail(`the settings file configures github.app for ${read.app.slug}, not this app`);
	const appId = read.app.id ?? fail("set github.app.id in the Harnessy settings file");
	const keyFile = keyFileEnv?.trim() || read.app.keyFile;
	const source =
		read.app.keySource ?? (keyFile !== undefined ? "file" : platform === "darwin" ? "keychain" : undefined);
	if (source === undefined) fail("set HSY_GITHUB_APP_KEY_FILE to the app's PEM private key file");
	if (source === "keychain" && platform !== "darwin") fail("the keychain key source works only on macOS");
	const keySource: KeySource =
		source === "keychain"
			? { kind: "keychain", service: keychainService(slug), account: KEYCHAIN_ACCOUNT }
			: { kind: "file", path: keyFile ?? fail("github.app.keySource is file but no key file is named") };
	return {
		slug,
		appId,
		keySource,
		...(read.operator === undefined ? {} : { operator: read.operator }),
		...(read.app.botUserId === undefined ? {} : { botUserId: read.app.botUserId }),
	};
};

/** PEM text from either a PEM or the base64 of one. */
const pemOf = (text: string): string | undefined => {
	const trimmed = text.trim();
	const pem = trimmed.includes("-----BEGIN") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
	return /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(pem) ? pem : undefined;
};

/** Load the app's private key. Its text is registered as a secret and never leaves this process. */
export const loadPrivateKey = async (
	source: KeySource,
	run: Run,
	readFile: (path: string) => string,
): Promise<KeyObject> => {
	let text: string;
	if (source.kind === "keychain") {
		const found = await run(
			["/usr/bin/security", "find-generic-password", "-s", source.service, "-a", source.account, "-w"],
			{
				timeoutMs: KEYCHAIN_TIMEOUT_MS,
			},
		);
		if (found.exitCode !== 0)
			throw new GitHubAppAuthError(
				`the app's private key is not in the keychain (service ${source.service}, account ${source.account})`,
			);
		text = found.stdout;
	} else {
		const read = Result.try(() => readFile(source.path));
		if (Result.isFailure(read)) throw new GitHubAppAuthError("the app's private key file could not be read");
		text = read.success;
	}
	registerSecret(text.trim());
	const pem = pemOf(text);
	const key = pem === undefined ? undefined : Result.try(() => createPrivateKey(pem));
	if (pem === undefined || key === undefined || Result.isFailure(key))
		throw new GitHubAppAuthError("the app's private key is not a PEM private key");
	registerSecret(pem);
	return key.success;
};

/** RS256 app JWT: issued a minute in the past for clock skew, valid for ten minutes. */
export const appJwt = (appId: number, key: KeyObject, nowMs: number): string => {
	const iat = Math.floor(nowMs / 1000) - 60;
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const input = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat, exp: iat + 600, iss: String(appId) })}`;
	return `${input}.${sign("sha256", Buffer.from(input), key).toString("base64url")}`;
};

/** Call the GitHub API; failures are fixed text with the HTTP status, never a body, token or key. */
const api = async (
	fetch: GitHubFetch,
	method: "GET" | "POST",
	path: string,
	bearer: string,
	what: string,
	hints: Readonly<Record<number, string>> = {},
	body?: string,
): Promise<unknown> => {
	const response = await fetch(`${GITHUB_API}${path}`, {
		method,
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${bearer}`,
			"user-agent": "harnessy-work",
			"x-github-api-version": "2022-11-28",
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body }),
		signal: AbortSignal.timeout(API_TIMEOUT_MS),
		redirect: "error",
	}).catch(() => undefined);
	if (response === undefined) throw new GitHubAppAuthError(`${what} failed: GitHub could not be reached`);
	if (response.status < 200 || response.status > 299)
		throw new GitHubAppAuthError(`${what} failed (HTTP ${response.status})${hints[response.status] ?? ""}`);
	return response.json().catch(() => {
		throw new GitHubAppAuthError(`${what} returned no JSON`);
	});
};

/** A minted installation token and when GitHub expires it, in epoch milliseconds. */
export interface InstallationToken {
	readonly token: string;
	readonly expiresAt: number;
}

/** `owner/name` of a github.com remote URL (https, ssh or scp form), else undefined. */
export const githubRepoOf = (url: string): string | undefined => {
	const match =
		/^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(
			url.trim(),
		);
	return match === null ? undefined : `${match[1]}/${match[2]}`;
};

/**
 * Mint an installation token limited to `repo` (`owner/name`): the app JWT
 * finds the installation, then asks for a token for that one repository.
 * The JWT and the token are registered as secrets before anything else.
 */
export const mintInstallationToken = async (
	fetch: GitHubFetch,
	appId: number,
	key: KeyObject,
	repo: string,
	nowMs: number,
): Promise<InstallationToken> => {
	const [owner = "", name = ""] = repo.split("/");
	const jwt = appJwt(appId, key, nowMs);
	registerSecret(jwt);
	const installation = await api(
		fetch,
		"GET",
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
		jwt,
		"finding the app installation",
		{
			401: ": GitHub rejected the app JWT; check github.app.id and the private key",
			404: `: the app is not installed on ${repo}`,
		},
	);
	const installationId = positiveInteger(record(installation)?.id);
	if (installationId === undefined) throw new GitHubAppAuthError("GitHub returned no installation id");
	const minted = record(
		await api(
			fetch,
			"POST",
			`/app/installations/${installationId}/access_tokens`,
			jwt,
			"minting an installation token",
			{ 422: `: the installation cannot reach ${repo}` },
			JSON.stringify({ repositories: [name] }),
		),
	);
	const token = minted?.token;
	const expiresAt = typeof minted?.expires_at === "string" ? Date.parse(minted.expires_at) : Number.NaN;
	if (typeof token !== "string" || !/^[!-~]{20,}$/u.test(token) || !Number.isFinite(expiresAt))
		throw new GitHubAppAuthError("GitHub returned no usable installation token");
	registerSecret(token);
	registerSecret(basicAuthorization(token));
	const scoped = Array.isArray(minted?.repositories)
		? minted.repositories.map((entry) => record(entry)?.full_name)
		: [];
	// GitHub compares repository names without regard to case.
	if (scoped.length !== 1 || String(scoped[0]).toLowerCase() !== repo.toLowerCase())
		throw new GitHubAppAuthError(`the minted token is not limited to ${repo}`);
	return { token, expiresAt };
};

/** The value after `AUTHORIZATION: ` that makes git send the token as HTTP basic auth. */
export const basicAuthorization = (token: string): string =>
	`basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

/** Tracing that could echo request headers into stderr, which Harnessy quotes in errors: off. */
const NO_TRACE = {
	GIT_TRACE: "0",
	GIT_TRACE_CURL: "0",
	GIT_TRACE_PACKET: "0",
	GIT_CURL_VERBOSE: "0",
	GIT_TRACE_REDACT: "1",
	GH_DEBUG: "",
} as const;

/**
 * Environment for one `git push` to `pushUrl`. The token travels as an
 * `http.<pushUrl>.extraheader` set through `GIT_CONFIG_*`, so it
 * is neither in the argv, nor in a URL, nor written to any git config file.
 * User and system config are skipped (no `insteadOf` rewrite to SSH, no
 * extra headers), credential helpers are cleared and only HTTPS is allowed,
 * so a rejected token fails the push instead of falling back to the
 * operator's credentials.
 */
export const gitPushEnv = (token: string, pushUrl: string): Readonly<Record<string, string>> => ({
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_COUNT: "4",
	// Keyed by the full push URL: git applies the most specific `http.<url>.*` match, so a
	// host-wide header in the repository's config (as actions/checkout writes) cannot win.
	// The empty value first clears any header an equally specific repository entry set.
	GIT_CONFIG_KEY_0: `http.${pushUrl}.extraheader`,
	GIT_CONFIG_VALUE_0: "",
	GIT_CONFIG_KEY_1: `http.${pushUrl}.extraheader`,
	GIT_CONFIG_VALUE_1: `AUTHORIZATION: ${basicAuthorization(token)}`,
	GIT_CONFIG_KEY_2: "credential.helper",
	GIT_CONFIG_VALUE_2: "",
	GIT_CONFIG_KEY_3: `credential.${pushUrl}.helper`,
	GIT_CONFIG_VALUE_3: "",
	GIT_ALLOW_PROTOCOL: "https",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "false",
	...NO_TRACE,
});

/** Environment for one `gh` call: the token, pinned to the repository it is limited to. */
export const ghEnv = (token: string, repo: string): Readonly<Record<string, string>> => ({
	GH_TOKEN: token,
	GH_HOST: "github.com",
	GH_REPO: repo,
	GH_PROMPT_DISABLED: "1",
	...NO_TRACE,
});

export interface GitHubAuth {
	readonly repo: string;
	/** Where Harnessy pushes in place of `origin`. */
	readonly pushUrl: string;
	/** A token valid for at least `runsForMs` plus `TOKEN_REFRESH_MS`; mints a fresh one when needed. */
	readonly token: (runsForMs?: number) => Promise<string>;
	/** Environment for a `gh` call that may run for `runsForMs`; mints a fresh token when needed. */
	readonly ghEnv: (runsForMs?: number) => Promise<Readonly<Record<string, string>>>;
	/** Environment for one `git push`; mints a fresh token when needed. */
	readonly pushEnv: () => Promise<Readonly<Record<string, string>>>;
}

/**
 * One run's installation tokens. A token is minted on first use and
 * replaced whenever less than `TOKEN_REFRESH_MS`, or less than the next
 * command's time limit plus that margin, remains. The key is loaded again
 * for each mint, so it is held only while signing.
 */
export const createGitHubAuth = (input: {
	readonly config: GitHubAppConfig;
	readonly repo: string;
	readonly run: Run;
	readonly fetch: GitHubFetch;
	readonly readFile: (path: string) => string;
	readonly now: () => number;
}): GitHubAuth => {
	let current: InstallationToken | undefined;
	const pushUrl = `https://github.com/${input.repo}.git`;
	const token = async (runsForMs = 0): Promise<string> => {
		if (current === undefined || current.expiresAt - input.now() < runsForMs + TOKEN_REFRESH_MS) {
			const key = await loadPrivateKey(input.config.keySource, input.run, input.readFile);
			current = await mintInstallationToken(input.fetch, input.config.appId, key, input.repo, input.now());
		}
		return current.token;
	};
	return {
		repo: input.repo,
		pushUrl,
		token,
		ghEnv: async (runsForMs) => ghEnv(await token(runsForMs), input.repo),
		pushEnv: async () => gitPushEnv(await token(), pushUrl),
	};
};

/** The bot account's noreply address, which GitHub links to the app. */
export const botEmail = (botUserId: number, slug: string): string =>
	`${botUserId}+${slug}[bot]@users.noreply.github.com`;

/** Author and committer of Harnessy's commits while the app is in use. */
export const commitIdentityEnv = (
	operator: string,
	botUserId: number,
	slug: string,
): Readonly<Record<string, string>> => {
	const name = `${AGENT_NAME} agent (operated by ${operator})`;
	const email = botEmail(botUserId, slug);
	return {
		GIT_AUTHOR_NAME: name,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: name,
		GIT_COMMITTER_EMAIL: email,
	};
};

/** Who did the work: commit trailers, and lines of the PR body. */
export const provenanceLines = (operator: string, task: string): ReadonlyArray<string> => [
	`Agent: ${AGENT_NAME}`,
	`Operator: ${operator}`,
	`WorkStream-Task: ${task}`,
];

/** `<stateRoot>/github-app/<slug>.json`: the cached bot user id. */
export const botCachePath = (stateRoot: string, slug: string): string => join(stateRoot, "github-app", `${slug}.json`);

/**
 * The app bot's GitHub user id, from the settings, else the cache file, else
 * `GET /users/<slug>[bot]` (then cached). Lookup failures stop the run.
 */
export const botUserId = async (
	config: GitHubAppConfig,
	cachePath: string,
	fetch: GitHubFetch,
	bearer: string,
	readFile: (path: string) => string,
): Promise<number> => {
	if (config.botUserId !== undefined) return config.botUserId;
	const cached = Result.try(() => positiveInteger(record(JSON.parse(readFile(cachePath)))?.botUserId));
	if (Result.isSuccess(cached) && cached.success !== undefined) return cached.success;
	const user = await api(
		fetch,
		"GET",
		`/users/${encodeURIComponent(`${config.slug}[bot]`)}`,
		bearer,
		"looking up the app's bot user",
		{
			404: `: no bot user ${config.slug}[bot] exists`,
		},
	);
	const id = positiveInteger(record(user)?.id);
	if (id === undefined) throw new GitHubAppAuthError("GitHub returned no bot user id");
	// A cache that cannot be written only costs one lookup next run.
	Result.try(() => {
		mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
		const temporary = `${cachePath}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ botUserId: id })}\n`, { mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, cachePath);
	});
	return id;
};

/** Everything one run needs to act as the app. */
export interface GitHubAppRun {
	readonly auth: GitHubAuth;
	readonly operator: string;
	/** `GIT_AUTHOR_*` and `GIT_COMMITTER_*` for Harnessy's commits. */
	readonly identity: Readonly<Record<string, string>>;
	/** Commit trailers and PR body lines. */
	readonly provenance: ReadonlyArray<string>;
}

/**
 * Prepare a run to act as the app, before it claims anything: find the
 * github.com repository behind `origin`, the operator's name, a first token
 * (which proves the key, the app id and the installation work) and the bot
 * user id. Any failure throws `GitHubAppAuthError`.
 */
export const setUpGitHubApp = async (input: {
	readonly config: GitHubAppConfig;
	readonly repoPath: string;
	readonly task: string;
	readonly run: Run;
	readonly fetch: GitHubFetch;
	readonly readFile: (path: string) => string;
	readonly now: () => number;
	readonly stateRoot: string;
}): Promise<GitHubAppRun> => {
	const origin = await input.run(["git", "-C", input.repoPath, "remote", "get-url", "origin"]);
	const repo = origin.exitCode === 0 ? githubRepoOf(origin.stdout) : undefined;
	if (repo === undefined) throw new GitHubAppAuthError("the checkout's origin remote is not a github.com repository");
	const gitName =
		input.config.operator === undefined
			? await input.run(["git", "-C", input.repoPath, "config", "user.name"])
			: undefined;
	const operator = input.config.operator ?? (gitName?.exitCode === 0 ? operatorName(gitName.stdout) : undefined);
	if (operator === undefined)
		throw new GitHubAppAuthError("no operator name: set operator in the Harnessy settings file, or git user.name");
	const auth = createGitHubAuth({ ...input, repo });
	const token = await auth.token();
	const bot = await botUserId(
		input.config,
		botCachePath(input.stateRoot, input.config.slug),
		input.fetch,
		token,
		input.readFile,
	);
	return {
		auth,
		operator,
		identity: commitIdentityEnv(operator, bot, input.config.slug),
		provenance: provenanceLines(operator, input.task),
	};
};
