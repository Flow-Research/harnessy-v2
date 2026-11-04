/**
 * Read-only service health from `launchctl print`.
 *
 * Raw `launchctl print` output can contain a job's environment variables, so it
 * is never returned. The parser keeps five top-level fields only. Log text never
 * leaves this module: the newest log is reported as its stream, modified time and,
 * for a JSON line, one allow-listed code.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import * as Result from "effect/Result";

import { FATHOM_LAUNCH_AGENT_LABEL } from "../jarvis/fathom/schedule.ts";
import { LIFE_LAUNCH_AGENT_LABELS } from "../jarvis/life-orchestrator/schedule.ts";
import { readBoundedFile } from "./files.ts";
import { SERVICE_LOG_CODES, type ServiceHealthData } from "./schemas.ts";
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
/** The learning wiki viewer on 127.0.0.1:4321 (a preview install). */
export const LEARNING_WIKI_SERVICE_LABEL = "tech.flowresearch.learning-wiki";

/** The fixed services the portal reports on. */
export const PORTAL_SERVICE_LABELS = [
	...LIFE_LAUNCH_AGENT_LABELS,
	FATHOM_LAUNCH_AGENT_LABEL,
	MEETING_PUBLICATION_SERVICE_LABEL,
	COMMUNITY_REVIEW_SERVICE_LABEL,
	PORTAL_SERVICE_LABEL,
	LEARNING_WIKI_SERVICE_LABEL,
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

const LOG_CODE_SET: ReadonlySet<string> = new Set(SERVICE_LOG_CODES);
type ServiceLogCode = (typeof SERVICE_LOG_CODES)[number];

/**
 * Classify one log line without returning any of its text. A plain-text line gives `null`.
 * A JSON object line gives its `kind`, `error` or `code` value (in that order) when that
 * value is on the allow-list, and `other` otherwise. Nothing else from the line is kept.
 */
export const classifyLogLine = (line: string): ServiceLogCode | null => {
	const parsed = Result.try(() => JSON.parse(line) as unknown);
	if (Result.isFailure(parsed) || typeof parsed.success !== "object" || parsed.success === null) return null;
	if (Array.isArray(parsed.success)) return "other";
	const record = parsed.success as Record<string, unknown>;
	for (const key of ["kind", "error", "code"]) {
		const value = record[key];
		if (typeof value === "string" && LOG_CODE_SET.has(value)) return value as ServiceLogCode;
	}
	return "other";
};

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
	return text === undefined ? null : { code: classifyLogLine(text), modifiedAt: file.modifiedAt };
};

const newestLog = (fields: LaunchctlFields, homeRoot: string): ServiceHealthData["lastLog"] => {
	let newest: ServiceHealthData["lastLog"] = null;
	for (const [stream, path] of [
		["stdout", fields.stdoutPath],
		["stderr", fields.stderrPath],
	] as const) {
		if (path === null) continue;
		// An unreadable, missing or unsafe log file simply has no last line.
		const read = Result.try(() => lastLine(path, homeRoot));
		const line = Result.isSuccess(read) ? read.success : null;
		if (line !== null && (newest === null || line.modifiedAt.toISOString() > newest.modifiedAt))
			newest = { stream, modifiedAt: line.modifiedAt.toISOString(), code: line.code };
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
					lastLog: newestLog(fields, homeRoot),
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
