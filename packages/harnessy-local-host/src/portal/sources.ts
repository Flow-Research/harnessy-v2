/**
 * The portal's data: the Core read model, read for one home directory.
 *
 * Every function here reads only. None opens SQLite for writing, calls
 * `LifeReadingLedger.open`, reads another service's token or bootstrap file, or
 * spawns anything other than the injected launchd probe.
 */
import { statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
	type CommunitySummary,
	extractBriefTasks,
	type FathomAccountsData,
	type FathomSummary,
	guardTile,
	type LaunchdProbe,
	LIFE_BRIEF_DAYS,
	type LifeOrchestratorSettings,
	type LifeSummary,
	lifeBriefPathIfPresent,
	type MeetingSummary,
	okTile,
	PORTAL_SERVICE_LABELS,
	readCommunityStateRoot,
	readCommunitySummary,
	readFathomSummary,
	readLifeBrief,
	readLifeBriefDates,
	readLifeSummary,
	readLifeWeeklyDraft,
	readMeetingPublicationConfig,
	readMeetingSummary,
	readServiceHealth,
	readSkillsSummary,
	readTasks,
	readWorkspaceSummary,
	resolveLifeOrchestratorSettings,
	stateTile,
	type TaskListData,
	type TileResult,
	type WaitingData,
} from "@harnessy/core/read-model";

import {
	cockpitConnections,
	codexConnections,
	communityConnections,
	fathomConnections,
	googleWorkspaceConnections,
	meetingConnections,
} from "./connections.ts";
import { deriveInbox } from "./inbox.ts";
import { readJobs } from "./jobs.ts";
import { readLearningSummary } from "./learning.ts";
import { type PortProbe, tcpPortProbe } from "./liveness.ts";
import type { PortalRouteParams } from "./routes.ts";

export interface PortalSourceOptions {
	/** The home directory whose Harnessy state is read. */
	readonly homeRoot: string;
	readonly workspaceRoot?: string;
	/** The environment for `JARVIS_*` configuration overrides and `HARNESSY_WORKSPACE_ROOT`. */
	readonly env: NodeJS.ProcessEnv;
	readonly probe: LaunchdProbe;
	/** SQLite busy timeout for one read. */
	readonly timeoutMs: number;
	readonly clock: () => Date;
	/** Loopback liveness probe for the Jobs list; defaults to a 300 ms TCP connect. */
	readonly probePort?: PortProbe;
}

export type PortalTiles = Readonly<Record<string, TileResult<unknown>>>;

/** One source fills one response's tiles. Path parameters arrive already checked against their patterns. */
export type PortalSource = (params?: PortalRouteParams) => PortalTiles;
/** A source that waits on loopback liveness probes. */
export type PortalAsyncSource = (params?: PortalRouteParams) => Promise<PortalTiles>;

export interface PortalSources {
	readonly today: PortalSource;
	readonly health: PortalSource;
	readonly connections: PortalSource;
	readonly meetings: PortalSource;
	readonly community: PortalSource;
	readonly learning: PortalSource;
	readonly workspace: PortalSource;
	readonly inbox: PortalAsyncSource;
	readonly lifeBrief: PortalSource;
	readonly lifeWeeklyDraft: PortalSource;
	readonly tasks: PortalSource;
	readonly jobs: PortalAsyncSource;
}

const MAX_LIFE_CONFIG_BYTES = 1024 * 1024;

type LifeSettings =
	| { readonly settings: LifeOrchestratorSettings }
	| { readonly state: "error" | "unsafe"; readonly reason: string };

const lifeSettings = (options: PortalSourceOptions, homeRoot: string): LifeSettings => {
	// `resolveLifeOrchestratorSettings` reads the Life config whole; refuse a FIFO or an oversize file first.
	// A path that cannot be checked (a symlink loop, an unreadable directory) is refused like an unsafe one.
	let refused: string | undefined;
	try {
		const config = statSync(join(homeRoot, ".agents", "life", "config.json"), { throwIfNoEntry: false });
		if (config !== undefined && (!config.isFile() || config.size > MAX_LIFE_CONFIG_BYTES))
			refused = "life_config_unsafe";
	} catch {
		refused = "life_config_unreadable";
	}
	const user = options.env.FLOW_USER ?? options.env.USER;
	let settings: ReturnType<typeof resolveLifeOrchestratorSettings> | undefined;
	if (refused === undefined) {
		try {
			settings = resolveLifeOrchestratorSettings({
				homeRoot,
				projectRoot: options.workspaceRoot ?? homeRoot,
				...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
				...(user === undefined ? {} : { user }),
			});
		} catch {
			settings = undefined;
		}
	}
	if (settings === undefined)
		return { state: refused === undefined ? "error" : "unsafe", reason: refused ?? "life_settings_invalid" };
	return { settings };
};

const lifeTiles = (life: LifeSettings, options: PortalSourceOptions, now: Date): LifeSummary => {
	if (!("settings" in life)) {
		const failed = stateTile<never>(life.state, life.reason, now);
		return { readings: failed, brief: failed, latestPreview: failed, weeklyRuns: failed, setup: failed };
	}
	return readLifeSummary(life.settings, { now, timeoutMs: options.timeoutMs });
};

const lagosDay = (date: Date): string =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: "Africa/Lagos",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);

/** Per-account Fathom state: inbox counts and poll checkpoint freshness side by side. */
export const fathomAccountsTile = (summary: FathomSummary, now: Date): TileResult<FathomAccountsData> => {
	if (summary.checkpoint.state !== "ok")
		return stateTile(
			summary.checkpoint.state as Exclude<typeof summary.checkpoint.state, "ok">,
			summary.checkpoint.reason!,
			now,
		);
	const checkpoint = summary.checkpoint.data!;
	const inbox = summary.inbox.state === "ok" ? summary.inbox.data!.accounts : {};
	return okTile(
		{
			intervalSeconds: checkpoint.intervalSeconds,
			accounts: checkpoint.accounts.slice(0, 32).map((account) => {
				const counts = Object.hasOwn(inbox, account.account) ? inbox[account.account] : undefined;
				return {
					account: account.account.slice(0, 64),
					pending: counts?.pending ?? null,
					processed: counts?.processed ?? null,
					invalid: counts?.invalid ?? null,
					updatedAt: account.updatedAt,
					ageSeconds: account.ageSeconds,
					stale: account.stale,
				};
			}),
		},
		now,
	);
};

/** Tasks remember, per source line, the identity seen at the last read, to flag edited lines. */
const MAX_REMEMBERED_TASK_LINES = 5_000;

/** Build the portal's sources. Each call reads afresh; the server caches the results. */
export const createPortalSources = (options: PortalSourceOptions): PortalSources => {
	const homeRoot = resolve(options.homeRoot);
	const configPath = join(homeRoot, ".jarvis", "config.yaml");
	const read = { timeoutMs: options.timeoutMs };
	const probePort = options.probePort ?? tcpPortProbe();
	const user = options.env.FLOW_USER ?? options.env.USER;
	const seenTaskLines = new Map<string, string>();

	/** The meeting summary, plus the review state path for the opener command (never returned as data). */
	const meeting = (now: Date): MeetingSummary & { readonly statePath: string | null } => {
		const config = readMeetingPublicationConfig({ homeRoot, configPath, env: options.env, now });
		if (config.state !== "ok") {
			const failed = stateTile<never>(config.state, config.reason!, now);
			return { config: failed, queue: failed, providers: failed, statePath: null };
		}
		return { ...readMeetingSummary(config.data!, { ...read, now }), statePath: config.data!.statePath };
	};
	const fathom = (now: Date): FathomSummary => readFathomSummary({ ...read, now, homeRoot, configPath });
	const community = (now: Date): CommunitySummary => readCommunitySummary({ ...read, now, homeRoot, configPath });
	/** The community review state directory, from the same configuration the summary read. */
	const communityStatePath = (): string | null => readCommunityStateRoot({ homeRoot, configPath });
	const workspaceRootOf = (life: LifeSettings): string | null =>
		"settings" in life && life.settings.paths.projectRoot !== homeRoot ? life.settings.paths.projectRoot : null;
	const connections = (
		now: Date,
		meetings: MeetingSummary,
		fathomSummary: FathomSummary,
		communitySummary: CommunitySummary,
	) => ({
		meeting: meetingConnections(meetings, now),
		fathom: fathomConnections(fathomSummary, now),
		community: communityConnections(communitySummary, now),
		cockpit: cockpitConnections(now),
		googleWorkspace: googleWorkspaceConnections(homeRoot, now),
		codex: codexConnections(homeRoot, now),
	});
	const jobs = async (
		now: Date,
		life: LifeSettings,
		meetings: ReturnType<typeof meeting>,
		communitySummary: CommunitySummary,
	) =>
		readJobs({
			now,
			homeRoot,
			health: readServiceHealth(PORTAL_SERVICE_LABELS, options.probe, { homeRoot, now }),
			probePort,
			workspaceRoot: workspaceRootOf(life),
			meetingPort: meetings.config.state === "ok" ? meetings.config.data!.reviewPort : null,
			meetingStatePath: meetings.statePath,
			communityPort: communitySummary.config.state === "ok" ? communitySummary.config.data!.reviewPort : null,
			communityStatePath: communityStatePath(),
		});

	return {
		today: () => {
			const now = options.clock();
			const life = lifeTiles(lifeSettings(options, homeRoot), options, now);
			const meetings = meeting(now);
			const queue = community(now).queue;
			const inbox = fathom(now).inbox;
			const waiting: WaitingData = {
				meetingsPendingReview:
					meetings.queue.state === "ok" ? (meetings.queue.data!.statusCounts.pending_review ?? 0) : null,
				communityPendingReview: queue.state === "ok" ? (queue.data!.counts.pending_review ?? 0) : null,
				fathomPendingInbox: inbox.state === "ok" ? inbox.data!.totals.pending : null,
				weeklyRunsDrafted: life.weeklyRuns.state === "ok" ? (life.weeklyRuns.data!.counts.drafted ?? 0) : null,
			};
			return { ...life, waiting: { state: "ok", data: waiting, readAt: now.toISOString() } };
		},
		health: () => readServiceHealth(PORTAL_SERVICE_LABELS, options.probe, { homeRoot, now: options.clock() }),
		connections: () => {
			const now = options.clock();
			return connections(now, meeting(now), fathom(now), community(now));
		},
		meetings: () => {
			const now = options.clock();
			const { statePath: _statePath, ...meetings } = meeting(now);
			const fathomSummary = fathom(now);
			return {
				...meetings,
				fathomConfig: fathomSummary.config,
				fathomInbox: fathomSummary.inbox,
				fathomCheckpoint: fathomSummary.checkpoint,
			};
		},
		community: () => ({ ...community(options.clock()) }),
		learning: () => {
			const now = options.clock();
			return {
				catalog: readLearningSummary({
					root: join(homeRoot, ".harnessy", "jarvis", "wiki", "learning"),
					now,
					timeoutMs: options.timeoutMs,
				}),
			};
		},
		workspace: () => {
			const now = options.clock();
			return {
				workspace: readWorkspaceSummary({
					now,
					cwd: homeRoot,
					env: options.env,
					...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
				}),
				skills: readSkillsSummary({ now, homeRoot }),
			};
		},
		inbox: async () => {
			const now = options.clock();
			const life = lifeSettings(options, homeRoot);
			const summary = lifeTiles(life, options, now);
			const meetings = meeting(now);
			const fathomSummary = fathom(now);
			const communitySummary = community(now);
			const brief = "settings" in life ? readLifeBrief(life.settings, now, { now }) : undefined;
			const jobList = await jobs(now, life, meetings, communitySummary);
			return {
				inbox: guardTile(now, () =>
					okTile(
						deriveInbox({
							now,
							weeklyRuns: summary.weeklyRuns,
							briefDecisions:
								brief?.state === "ok"
									? {
											date: brief.data!.date,
											count: extractBriefTasks(brief.data!.text).filter((task) => task.status === "todo")
												.length,
										}
									: null,
							meetingConfig: meetings.config,
							meetingQueue: meetings.queue,
							meetingStatePath: meetings.statePath,
							communityConfig: communitySummary.config,
							communityQueue: communitySummary.queue,
							communityGeneration: communitySummary.generation,
							communityStatePath: communityStatePath(),
							fathomAccounts: fathomAccountsTile(fathomSummary, now),
							workspaceRoot: workspaceRootOf(life),
							jobs: jobList,
							connections: connections(now, meetings, fathomSummary, communitySummary),
						}),
						now,
					),
				),
			};
		},
		lifeBrief: (params = {}) => {
			const now = options.clock();
			const life = lifeSettings(options, homeRoot);
			if (!("settings" in life)) {
				const failed = stateTile<never>(life.state, life.reason, now);
				return { brief: failed, dates: failed };
			}
			const dates = readLifeBriefDates(life.settings, { now });
			const requested = params.date;
			if (requested === undefined) return { brief: readLifeBrief(life.settings, now, { now }), dates };
			// Only the switcher's own days are served; any other date is refused without a file read.
			const recent = Array.from({ length: LIFE_BRIEF_DAYS }, (_, offset) =>
				lagosDay(new Date(now.getTime() - offset * 86_400_000)),
			);
			if (!recent.includes(requested)) return { brief: stateTile("error", "date_out_of_range", now), dates };
			return { brief: readLifeBrief(life.settings, new Date(`${requested}T12:00:00Z`), { now }), dates };
		},
		lifeWeeklyDraft: (params = {}) => {
			const now = options.clock();
			const life = lifeSettings(options, homeRoot);
			if (!("settings" in life)) return { draft: stateTile(life.state, life.reason, now) };
			return { draft: readLifeWeeklyDraft(life.settings, params.runId ?? "", { now }) };
		},
		tasks: () => {
			const now = options.clock();
			const life = lifeSettings(options, homeRoot);
			if (!("settings" in life)) return { tasks: stateTile(life.state, life.reason, now) };
			const paths = life.settings.paths;
			const brief = lifeBriefPathIfPresent(life.settings, now);
			const tile: TileResult<TaskListData> = readTasks({
				now,
				lifeDirectory: paths.lifeDirectory,
				briefPath: brief,
				privateContextDirectory:
					paths.contextRoot === undefined || user === undefined ? null : join(paths.contextRoot, "private", user),
				homeRoot,
				ownerNames: user === undefined ? [] : [user],
			});
			if (tile.state !== "ok") return { tasks: tile };
			if (seenTaskLines.size > MAX_REMEMBERED_TASK_LINES) seenTaskLines.clear();
			const tasks = tile.data!.tasks.map((task) => {
				const place = `${task.source.kind}\0${task.source.path}\0${task.source.line}`;
				const previous = seenTaskLines.get(place);
				seenTaskLines.set(place, task.id);
				return previous === undefined || previous === task.id ? task : { ...task, sourceChanged: true };
			});
			return { tasks: { ...tile, data: { ...tile.data!, tasks } } };
		},
		jobs: async () => {
			const now = options.clock();
			const life = lifeSettings(options, homeRoot);
			const meetings = meeting(now);
			const communitySummary = community(now);
			return {
				jobs: okTile(await jobs(now, life, meetings, communitySummary), now),
				communityGeneration: communitySummary.generation,
				fathomAccounts: fathomAccountsTile(fathom(now), now),
			};
		},
	};
};
