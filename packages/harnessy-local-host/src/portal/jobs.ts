/**
 * The Jobs table: every Harnessy launchd job and service in one list.
 *
 * Each row joins a fixed description (what the job is, its schedule, its port
 * and the commands that control it) with what can be observed now: launchd
 * state from the health probe, the newest log's modified time, and a loopback
 * liveness probe. Every control is a command to copy or a link to the owning
 * service. Nothing here starts, stops or reloads a job.
 *
 * The community review service is never offered a pause, stop or restart: a
 * loaded label without a process escalates to stopping publication.
 */
import { join } from "node:path";

import {
	type AppActionData,
	COMMUNITY_REVIEW_SERVICE_LABEL,
	describeJobSchedule,
	JOB_SCHEDULE_TIMEZONE,
	JOB_SCHEDULES,
	type JobData,
	type JobListData,
	LEARNING_WIKI_SERVICE_LABEL,
	MEETING_PUBLICATION_SERVICE_LABEL,
	nextJobRun,
	PORTAL_SERVICE_LABEL,
	readBoundedFile,
	type ServiceHealthData,
	type TileResult,
} from "@harnessy/core/read-model";

import type { LoopbackHost, PortProbe } from "./liveness.ts";

const FATHOM_LABEL = "com.flow-harness.meeting-fathom-poll";
const LIFE_RESEARCH_LABEL = "com.flow-harness.life-orchestrator.learning-research";
const LIFE_DAILY_LABEL = "com.flow-harness.life-orchestrator.daily-brief";
const LIFE_WEEKLY_LABEL = "com.flow-harness.life-orchestrator.weekly-plan";

export const MEETING_REVIEW_DEFAULT_PORT = 8770;
export const COMMUNITY_REVIEW_DEFAULT_PORT = 8872;
export const LEARNING_WIKI_PORT = 4321;
export const EXECUTOR_PORT = 4788;
export const PORTAL_PORT = 8790;

/** Log codes that mark the last run as worth a look. */
const ATTENTION_LOG_CODES: ReadonlySet<string> = new Set([
	"error",
	"fatal",
	"poll_failed",
	"authentication_failed",
	"reauth_required",
	"invalid_rapt",
	"refresh_token_revoked",
	"permission_denied",
	"database_busy",
	"read_failed",
	"unsafe_state",
	"schema_invalid",
]);

export interface JobsContext {
	readonly now: Date;
	readonly homeRoot: string;
	/** `launchctl print` results per label, as `/v1/health` reports them. */
	readonly health: Readonly<Record<string, TileResult<ServiceHealthData>>>;
	readonly probePort: PortProbe;
	/** Where the Fathom poll runs (`--target`); `null` when no workspace is known. */
	readonly workspaceRoot: string | null;
	readonly meetingPort: number | null;
	/** The configured review host (`127.0.0.1`, `::1` or `localhost`); `null` when unknown. */
	readonly meetingHost?: string | null;
	readonly meetingStatePath: string | null;
	readonly communityPort: number | null;
	readonly communityHost?: string | null;
	readonly communityStatePath: string | null;
}

/** The loopback addresses a review service with configured `host` listens on. Unknown hosts default to IPv4. */
export const reviewHostsOf = (host: string | null | undefined): ReadonlyArray<LoopbackHost> =>
	host === "::1" ? ["::1"] : host === "localhost" ? ["127.0.0.1", "::1"] : ["127.0.0.1"];

/** The URL of a loopback review service, in the address family it listens on; `null` for any other host. */
export const reviewUrl = (host: string | null | undefined, port: number | null | undefined): string | null => {
	if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65_535) return null;
	if (host === "::1") return `http://[::1]:${port}/`;
	if (host === "127.0.0.1") return `http://127.0.0.1:${port}/`;
	if (host === "localhost") return `http://localhost:${port}/`;
	return null;
};

const copy = (label: string, target: string, note: string | null = null): AppActionData => ({
	kind: "copy",
	label,
	target,
	note,
});
const link = (label: string, target: string, note: string | null = null): AppActionData => ({
	kind: "handoff",
	label,
	target,
	note,
});

/** Control and invisible format characters: a copied command must show every byte it holds. */
export const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Quote a path for a copied shell command when it holds anything but plain
 * characters. A path with control or invisible format characters (a bidi
 * override, say) is never put in a command: its placeholder is.
 */
export const shellPath = (value: string, placeholder = "<path>"): string =>
	HIDDEN_CHARACTERS.test(value)
		? placeholder
		: /^[A-Za-z0-9_./~-]+$/u.test(value)
			? value
			: `'${value.replaceAll("'", "'\\''")}'`;

interface JobDefinition {
	readonly id: string;
	readonly name: string;
	readonly label: string | null;
	readonly kind: JobData["kind"];
	readonly port: number | null;
	readonly hosts: ReadonlyArray<LoopbackHost>;
	readonly notes: ReadonlyArray<string>;
	readonly controls: ReadonlyArray<AppActionData>;
	readonly neverPause: boolean;
	readonly schedule?: string;
}

/** The fixed job table. Ports and commands that depend on configuration are filled from `context`. */
export const jobDefinitions = (context: JobsContext): ReadonlyArray<JobDefinition> => {
	const target = context.workspaceRoot === null ? "<workspace>" : shellPath(context.workspaceRoot, "<workspace>");
	const meetingState =
		context.meetingStatePath === null ? "<state path>" : shellPath(context.meetingStatePath, "<state path>");
	const communityState =
		context.communityStatePath === null ? "<state path>" : shellPath(context.communityStatePath, "<state path>");
	const meetingPort = context.meetingPort ?? MEETING_REVIEW_DEFAULT_PORT;
	const communityPort = context.communityPort ?? COMMUNITY_REVIEW_DEFAULT_PORT;
	const meetingUrl = reviewUrl(context.meetingHost, meetingPort) ?? `http://127.0.0.1:${meetingPort}/`;
	const communityUrl = reviewUrl(context.communityHost, communityPort) ?? `http://127.0.0.1:${communityPort}/`;
	const reinstall = (command: string) => copy("Reinstall schedule", command, "Writes the plist; does not load it.");
	return [
		{
			id: "fathom-poll",
			name: "Fathom poll",
			label: FATHOM_LABEL,
			kind: "timed",
			port: null,
			hosts: [],
			notes: ["Imports new Fathom recordings into the meeting inbox.", "Reauthorisation has no command yet."],
			controls: [
				copy("Run now", `harnessy jarvis meeting fathom poll --target ${target} --json`),
				copy("Status", "harnessy jarvis meeting fathom status"),
				reinstall("harnessy jarvis meeting fathom schedule --apply"),
			],
			neverPause: false,
		},
		{
			id: "learning-research",
			name: "Learning research",
			label: LIFE_RESEARCH_LABEL,
			kind: "timed",
			port: null,
			hosts: [],
			notes: ["Finds readings for the reading queue."],
			controls: [
				copy("Run now", "harnessy jarvis life research", "Spends AI budget."),
				reinstall("harnessy jarvis life schedule --apply"),
			],
			neverPause: false,
		},
		{
			id: "daily-brief",
			name: "Daily brief",
			label: LIFE_DAILY_LABEL,
			kind: "timed",
			port: null,
			hosts: [],
			notes: ["Writes today's brief and its journal entry."],
			controls: [
				copy("Run now", "harnessy jarvis life daily --max-output-bytes 1048576", "Spends AI budget."),
				reinstall("harnessy jarvis life schedule --apply"),
			],
			neverPause: false,
		},
		{
			id: "weekly-plan",
			name: "Weekly plan",
			label: LIFE_WEEKLY_LABEL,
			kind: "timed",
			port: null,
			hosts: [],
			notes: ["Drafts the weekly plan for review. A period with an unreconciled run does not run again."],
			controls: [
				copy(
					"Run now",
					"harnessy jarvis life draft --kind weekly --timeout-seconds 600 --max-output-bytes 1048576",
					"Spends AI budget. Refused while the period has an unreconciled run.",
				),
				reinstall("harnessy jarvis life schedule --apply"),
			],
			neverPause: false,
		},
		{
			id: "community-review",
			name: "Community review and weekly drafts",
			label: COMMUNITY_REVIEW_SERVICE_LABEL,
			kind: "service",
			port: communityPort,
			hosts: reviewHostsOf(context.communityHost),
			schedule: "Sun 23:00 drafts",
			notes: [
				"Never paused, stopped or restarted from here: a loaded label without a process stops publication.",
				"Approve and publish on the community review page. Harnessy never posts to it.",
				"Never run `jarvis community briefing …` while publication runs.",
			],
			controls: [
				link("Open community review", communityUrl, "If it asks for a session, run the opener."),
				copy("Open with a session", `harnessy-community-review-open --state-path ${communityState}`),
				copy("Generation status", "harnessy jarvis community generation-status"),
			],
			neverPause: true,
		},
		{
			id: "meeting-publication",
			name: "Meeting publication",
			label: MEETING_PUBLICATION_SERVICE_LABEL,
			kind: "service",
			port: meetingPort,
			hosts: reviewHostsOf(context.meetingHost),
			notes: [
				"Enrolment-bound: not reboot-safe. Re-enrolment needs the owner key, offline.",
				"Approve and publish on the meeting review page. Harnessy never posts to it.",
			],
			controls: [
				link("Open meeting review", meetingUrl, "If it asks for a session, run the opener."),
				copy("Open with a session", `harnessy-meeting-review-open --state-path ${meetingState}`),
				copy("Service status", "harnessy-meeting-full-review --service-status"),
				copy("Enable service", "harnessy-meeting-full-review --service-enable"),
				copy("Disable service", "harnessy-meeting-full-review --service-disable"),
			],
			neverPause: false,
		},
		{
			id: "portal",
			name: "Harnessy (this app)",
			label: PORTAL_SERVICE_LABEL,
			kind: "service",
			port: PORTAL_PORT,
			hosts: [],
			notes: ["Read-only. It never publishes, approves or runs a job."],
			controls: [copy("Status", "harnessy portal status")],
			neverPause: false,
		},
		{
			id: "learning-wiki",
			name: "Learning wiki",
			label: LEARNING_WIKI_SERVICE_LABEL,
			kind: "service",
			port: LEARNING_WIKI_PORT,
			hosts: ["127.0.0.1"],
			notes: ["Preview install."],
			controls: [link("Open wiki", `http://127.0.0.1:${LEARNING_WIKI_PORT}/`), copy("Open", "learning view")],
			neverPause: false,
		},
		{
			id: "executor",
			name: "Tools engine (cockpit)",
			label: null,
			kind: "on-demand",
			port: EXECUTOR_PORT,
			// `harnessy web` may bind either loopback family; a probe of one alone can miss it.
			hosts: ["::1", "127.0.0.1"],
			notes: [
				"Unsupervised: started by `harnessy web`, not by launchd.",
				"Holds the Executor token. This app never reads or relays it.",
			],
			controls: [copy("Start or open", "harnessy web")],
			neverPause: false,
		},
	];
};

const xmlText = (value: string): string =>
	value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");

/** Option names whose value is a secret: `--api-key x`, `--token=x`, `-password x`. */
const SECRET_OPTION =
	/^-{1,2}[\w.-]*(?:token|key|secret|passw(?:or)?d|credential|auth|bearer|cookie|session)[\w.-]*$/iu;
/** `NAME=value` with a shell-safe name, anywhere in an argument (`env FOO=x cmd`, `sh -c 'FOO=x cmd'`). */
const ASSIGNMENT = /(^|[\s;&|'"(])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|'"()]*)/gu;
/** `--secret-option=value` or `--secret-option value` inside a longer argument such as `sh -c '…'`. */
const INLINE_SECRET_OPTION =
	/(-{1,2}[\w.-]*(?:token|key|secret|passw(?:or)?d|credential|auth|bearer|cookie|session)[\w.-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s;&|'"()]+)/giu;
export const REDACTED = "<redacted>";

/**
 * Program arguments with every value that may be a secret replaced: the value
 * after a secret-named option, `--option=value` of one, and every `NAME=value`
 * assignment. Only the program, its plain options and its paths stay readable.
 */
export const redactProgramArguments = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
	const out: string[] = [];
	let redactNext = false;
	for (const arg of argv) {
		if (redactNext) {
			out.push(REDACTED);
			redactNext = false;
			continue;
		}
		const option = /^(-{1,2}[^=\s]+)=/u.exec(arg);
		if (option !== null && SECRET_OPTION.test(option[1]!)) {
			out.push(`${option[1]}=${REDACTED}`);
			continue;
		}
		if (SECRET_OPTION.test(arg)) {
			out.push(arg);
			redactNext = true;
			continue;
		}
		out.push(
			arg
				.replace(ASSIGNMENT, (_match, lead: string, name: string) => `${lead}${name}=${REDACTED}`)
				.replace(
					INLINE_SECRET_OPTION,
					(_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
				),
		);
	}
	return out;
};

/**
 * The `ProgramArguments` of a LaunchAgent plist, redacted, or `null` when the
 * plist is missing, unsafe or has none. The environment and every other key are
 * ignored.
 */
export const readProgramArguments = (homeRoot: string, label: string): ReadonlyArray<string> | null => {
	try {
		const file = readBoundedFile(join(homeRoot, "Library", "LaunchAgents", `${label}.plist`), 64 * 1024);
		if (file.truncated) return null;
		const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(file.bytes.toString("utf8"));
		if (array === null) return null;
		return redactProgramArguments(
			[...array[1]!.matchAll(/<string>([^<]*)<\/string>/gu)].slice(0, 32).map((match) => xmlText(match[1]!)),
		).map((arg) => arg.slice(0, 512));
	} catch {
		return null;
	}
};

/** The health reason of a job whose launchd state cannot be read on this platform at all. */
export const LAUNCHD_UNAVAILABLE = "launchd not available";

const healthOf = (
	definition: JobDefinition,
	tile: TileResult<ServiceHealthData> | undefined,
	open: boolean | null,
): { readonly health: JobData["health"]; readonly reason: string } => {
	if (definition.kind === "on-demand")
		return open === true ? { health: "ok", reason: "running" } : { health: "idle", reason: "not running" };
	if (tile === undefined || tile.state === "unsupported") return { health: "unknown", reason: LAUNCHD_UNAVAILABLE };
	if (tile.state === "missing") return { health: "error", reason: "not loaded" };
	if (tile.state !== "ok") return { health: "unknown", reason: `launchd ${tile.reason ?? tile.state}` };
	const data = tile.data!;
	if (definition.kind === "service") {
		if (data.pid === null) return { health: "error", reason: "loaded without a process" };
		if (open === false) return { health: "error", reason: "port not answering" };
		return { health: "ok", reason: "running" };
	}
	if (data.lastExitCode !== null && data.lastExitCode !== 0)
		return { health: "error", reason: `last exit ${data.lastExitCode}` };
	if (data.lastLog?.code !== null && data.lastLog?.code !== undefined && ATTENTION_LOG_CODES.has(data.lastLog.code))
		return { health: "attention", reason: `last log: ${data.lastLog.code}` };
	return { health: "ok", reason: data.pid === null ? "waiting for next run" : "running" };
};

/** Build the Jobs list. Liveness probes run in parallel; each takes at most its time limit. */
export const readJobs = async (context: JobsContext): Promise<JobListData> => {
	const definitions = jobDefinitions(context);
	const jobs = await Promise.all(
		definitions.map(async (definition): Promise<JobData> => {
			const tile = definition.label === null ? undefined : context.health[definition.label];
			const data = tile?.state === "ok" ? tile.data! : null;
			const liveness =
				definition.port === null
					? []
					: await Promise.all(
							definition.hosts.map(async (host) => ({
								host,
								port: definition.port!,
								open: await context.probePort(host, definition.port!),
							})),
						);
			const open = liveness.length === 0 ? null : liveness.some((probe) => probe.open);
			const lastActivity =
				data?.lastLog === null || data?.lastLog === undefined
					? null
					: { at: data.lastLog.modifiedAt, evidence: "log-mtime" as const };
			const schedule = definition.label === null ? undefined : JOB_SCHEDULES[definition.label];
			const next =
				schedule === undefined
					? null
					: nextJobRun(schedule, context.now, lastActivity === null ? null : new Date(lastActivity.at));
			const { health, reason } = healthOf(definition, tile, open);
			return {
				id: definition.id,
				name: definition.name,
				label: definition.label,
				kind: definition.kind,
				schedule:
					schedule !== undefined
						? describeJobSchedule(schedule)
						: (definition.schedule ?? (definition.port === null ? null : `port ${definition.port}`)),
				// launchd does not start a job whose label is not loaded: no next run is promised for it.
				nextRun: next === null || tile?.state === "missing" ? null : next.toISOString(),
				lastActivity,
				loaded:
					tile === undefined || (tile.state !== "ok" && tile.state !== "missing") ? null : tile.state === "ok",
				state: data?.state ?? null,
				stateReason: tile === undefined || tile.state === "ok" ? null : (tile.reason ?? tile.state),
				pid: data?.pid ?? null,
				lastExitCode: data?.lastExitCode ?? null,
				lastLogCode: data?.lastLog?.code ?? null,
				port: definition.port,
				liveness,
				health,
				healthReason: reason,
				programArguments:
					definition.label === null
						? null
						: (readProgramArguments(context.homeRoot, definition.label)?.slice() ?? null),
				notes: [...definition.notes],
				controls: [...definition.controls],
				neverPause: definition.neverPause,
			};
		}),
	);
	return {
		jobs,
		timezone: JOB_SCHEDULE_TIMEZONE,
		errorCount: jobs.filter((job) => job.health === "error").length,
	};
};
