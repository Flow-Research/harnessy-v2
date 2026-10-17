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

/** Remove query strings and mask tokens, bearer credentials and secrets in one log line. */
export const redactLogLine = (line: string): string =>
	line
		.replace(/\p{Cc}/gu, " ")
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/giu, "$1?[redacted]")
		.replace(/(\S)\?(?!\[redacted\])\S+/gu, "$1?[redacted]")
		.replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
		.replace(
			/\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie))("?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/giu,
			"$1$2[redacted]",
		)
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
