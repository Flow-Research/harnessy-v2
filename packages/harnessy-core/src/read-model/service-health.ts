/**
 * Read-only service health from `launchctl print`.
 *
 * Raw `launchctl print` output can contain a job's environment variables, so it
 * is never returned. The parser keeps five top-level fields only, and the last
 * log line is redacted before it leaves this module.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import * as Result from "effect/Result";

import { FATHOM_LAUNCH_AGENT_LABEL } from "../jarvis/fathom/schedule.ts";
import { LIFE_LAUNCH_AGENT_LABELS } from "../jarvis/life-orchestrator/schedule.ts";
import { readBoundedFile } from "./files.ts";
import type { ServiceHealthData } from "./schemas.ts";
import {
	guardTile,
	okTile,
	type ReadModelOptions,
	ReadModelStateError,
	readClock,
	stateTile,
	type TileResult,
} from "./tile.ts";

export const MEETING_PUBLICATION_SERVICE_LABEL = "org.harnessy.meeting-publication";
export const COMMUNITY_REVIEW_SERVICE_LABEL = "com.flow-harness.community-review-v2";
export const PORTAL_SERVICE_LABEL = "org.harnessy.portal";

/** The fixed services the portal reports on. */
export const PORTAL_SERVICE_LABELS = [
	...LIFE_LAUNCH_AGENT_LABELS,
	FATHOM_LAUNCH_AGENT_LABEL,
	MEETING_PUBLICATION_SERVICE_LABEL,
	COMMUNITY_REVIEW_SERVICE_LABEL,
	PORTAL_SERVICE_LABEL,
] as const;

export interface LaunchdProbeResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Print one launchd job. Returns `"unsupported"` where launchd does not exist. */
export type LaunchdProbe = (label: string) => LaunchdProbeResult | "unsupported";

export interface LaunchctlFields {
	readonly state: string | null;
	readonly pid: number | null;
	readonly lastExitCode: number | null;
	readonly stdoutPath: string | null;
	readonly stderrPath: string | null;
}

const LABEL = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/u;
const FIELD = /^(state|pid|last exit code|stdout path|stderr path) = (.*)$/u;
const LOG_TAIL_BYTES = 4 * 1024;
const MAX_LOG_LINE = 300;

/** Keep only the top-level `state`, `pid`, `last exit code`, `stdout path` and `stderr path` fields. */
export const parseLaunchctlPrint = (stdout: string): LaunchctlFields => {
	const fields: { -readonly [K in keyof LaunchctlFields]: LaunchctlFields[K] } = {
		state: null,
		pid: null,
		lastExitCode: null,
		stdoutPath: null,
		stderrPath: null,
	};
	let depth = 0;
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (line === "}") {
			depth = Math.max(0, depth - 1);
			continue;
		}
		const match = depth === 1 ? FIELD.exec(line) : null;
		if (match !== null) {
			const value = match[2]!.trim();
			if (match[1] === "state" && /^[a-z][a-z ]{0,31}$/u.test(value)) fields.state = value;
			else if (match[1] === "pid" && /^[1-9]\d{0,9}$/u.test(value)) fields.pid = Number(value);
			else if (match[1] === "last exit code" && /^-?\d{1,6}\b/u.test(value))
				fields.lastExitCode = Number.parseInt(value, 10);
			else if (match[1] === "stdout path" && isAbsolute(value)) fields.stdoutPath = value;
			else if (match[1] === "stderr path" && isAbsolute(value)) fields.stderrPath = value;
		}
		if (line.endsWith("{")) depth += 1;
	}
	return fields;
};

const REDACTED = "[redacted]";
/** A quoted value (with escapes) or the rest of an unquoted value. */
const QUOTED_VALUE = String.raw`"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?`;
/** Keys whose values are always secret. `authorization` and `cookie` are handled separately. */
const SECRET_KEY =
	"[A-Za-z0-9_-]*(?:token|secret|password|passwd|passphrase|pass|pwd|credentials?|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|session[_-]?id|signature|sig)";
const SECRET_ASSIGNMENT = new RegExp(String.raw`\b(${SECRET_KEY})("?\s*[=:]\s*)(${QUOTED_VALUE}|[^\s&,;]+)`, "giu");
/** `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie` hide the whole value, scheme included. */
const WHOLE_VALUE_HEADER = new RegExp(
	String.raw`\b((?:proxy-)?authorization|(?:set-)?cookie)("?\s*[=:]\s*)(${QUOTED_VALUE}|.*)`,
	"giu",
);
/** Credential shapes that are secret wherever they appear. */
const TOKEN_SHAPES: ReadonlyArray<RegExp> = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----.*/gu,
	/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/gu,
	/\bsk-[A-Za-z0-9_-]{12,}/gu,
	/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}/gu,
	/\bxox[a-z]-[A-Za-z0-9-]{8,}/gu,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
	/\bAIza[0-9A-Za-z_-]{20,}/gu,
	/\bya29\.[0-9A-Za-z_-]{10,}/gu,
	/\b1\/\/[0-9A-Za-z_-]{20,}/gu,
];
/** A long run of token characters with both a letter and a digit: a key, hash or opaque token. */
const LONG_OPAQUE = /[A-Za-z0-9+/_=-]{32,}/gu;

const maskOpaque = (run: string): string => (/[A-Za-z]/u.test(run) && /\d/u.test(run) ? REDACTED : run);

/**
 * Mask secrets in one log line. This is a deny-list, so it masks generously: query
 * strings and URL user information, the whole value of authorization and cookie
 * headers, values of secret-named keys, known credential shapes (JWT, provider
 * tokens, PEM keys) and any long opaque run that mixes letters and digits.
 */
export const redactLogLine = (line: string): string =>
	TOKEN_SHAPES.reduce((text, shape) => text.replace(shape, REDACTED), line.replace(/\p{Cc}/gu, " "))
		.replace(/\b(Bearer|Basic|Digest|Bot)\s+[A-Za-z0-9._~+/=-]{6,}/gu, `$1 ${REDACTED}`)
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/giu, `$1${REDACTED}@`)
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/giu, `$1?${REDACTED}`)
		.replace(/(\S)\?(?!\[redacted\])\S+/gu, `$1?${REDACTED}`)
		.replace(WHOLE_VALUE_HEADER, `$1$2${REDACTED}`)
		.replace(SECRET_ASSIGNMENT, `$1$2${REDACTED}`)
		.replace(LONG_OPAQUE, maskOpaque)
		.trim()
		.slice(0, MAX_LOG_LINE);

/**
 * The last line of a log inside `homeRoot` (already canonical). The parent directory is
 * resolved through `realpath`, so a symlinked directory cannot lead outside the home
 * directory; the file itself must not be a symlink.
 */
const lastLine = (path: string, homeRoot: string) => {
	const resolved = resolve(path);
	const canonical = join(realpathSync(dirname(resolved)), basename(resolved));
	const fromHome = relative(homeRoot, canonical);
	if (fromHome === "" || fromHome.startsWith("..") || isAbsolute(fromHome)) return null;
	const file = readBoundedFile(canonical, LOG_TAIL_BYTES, true);
	const lines = file.bytes.toString("utf8").split("\n");
	// In a truncated tail the first line is cut; drop it unless it is the only line.
	if (file.truncated && lines.length > 1) lines.shift();
	const text = lines
		.map((value) => value.trim())
		.reverse()
		.find((value) => value.length > 0);
	return text === undefined ? null : { text: redactLogLine(text), modifiedAt: file.modifiedAt };
};

const newestLogLine = (fields: LaunchctlFields, homeRoot: string): ServiceHealthData["lastLogLine"] => {
	let newest: ServiceHealthData["lastLogLine"] = null;
	for (const [stream, path] of [
		["stdout", fields.stdoutPath],
		["stderr", fields.stderrPath],
	] as const) {
		if (path === null) continue;
		// An unreadable, missing or unsafe log file simply has no last line.
		const read = Result.try(() => lastLine(path, homeRoot));
		const line = Result.isSuccess(read) ? read.success : null;
		if (line !== null && (newest === null || line.modifiedAt.toISOString() > newest.modifiedAt))
			newest = { stream, text: line.text, modifiedAt: line.modifiedAt.toISOString() };
	}
	return newest;
};

export interface ServiceHealthReadOptions extends ReadModelOptions {
	/** Log files are read only when they are inside this directory. */
	readonly homeRoot?: string;
}

/** One tile per label. A job that launchd does not know is `missing` with reason `not_loaded`. */
export const readServiceHealth = (
	labels: ReadonlyArray<string>,
	probe: LaunchdProbe,
	options: ServiceHealthReadOptions = {},
): Readonly<Record<string, TileResult<ServiceHealthData>>> => {
	const now = readClock(options);
	const requestedHome = resolve(options.homeRoot ?? homedir());
	const canonicalHome = Result.try(() => realpathSync(requestedHome));
	const homeRoot = Result.isSuccess(canonicalHome) ? canonicalHome.success : requestedHome;
	const tiles: Record<string, TileResult<ServiceHealthData>> = {};
	for (const label of labels) {
		tiles[label] = guardTile(now, () => {
			if (!LABEL.test(label)) return stateTile("error", "invalid_label", now);
			const result = probe(label);
			if (result === "unsupported") return stateTile("unsupported", "platform", now);
			if (result.status !== 0) {
				return `${result.stdout}\n${result.stderr}`.includes("Could not find service")
					? stateTile("missing", "not_loaded", now)
					: stateTile("error", "probe_failed", now);
			}
			const fields = parseLaunchctlPrint(result.stdout);
			return okTile(
				{
					label,
					state: fields.state,
					pid: fields.pid,
					lastExitCode: fields.lastExitCode,
					lastLogLine: newestLogLine(fields, homeRoot),
				},
				now,
			);
		});
	}
	return tiles;
};

export interface LaunchdProbeOptions {
	readonly platform?: NodeJS.Platform;
	/** Must resolve to a root-owned file that group and others cannot write. */
	readonly executable?: string;
	readonly uid?: number;
}

/**
 * The default probe: `/bin/launchctl print gui/<uid>/<label>`, without a shell,
 * with a 2 s timeout and a 64 KiB output limit. Other platforms never spawn.
 */
export const createLaunchdProbe = (options: LaunchdProbeOptions = {}): LaunchdProbe => {
	const platform = options.platform ?? process.platform;
	const uid = options.uid ?? process.getuid?.();
	const executable = options.executable ?? "/bin/launchctl";
	return (label) => {
		if (platform !== "darwin" || uid === undefined) return "unsupported";
		if (!LABEL.test(label)) throw new ReadModelStateError("error", "invalid_label");
		const resolved = realpathSync(executable);
		const stat = lstatSync(resolved);
		if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
			throw new ReadModelStateError("unsafe", "probe_unsafe");
		const result = spawnSync(resolved, ["print", `gui/${uid}/${label}`], {
			encoding: "utf8",
			shell: false,
			timeout: 2_000,
			maxBuffer: 64 * 1024,
			env: {},
		});
		if (result.error !== undefined || result.signal !== null) throw new ReadModelStateError("error", "probe_failed");
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	};
};
