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
	type FathomSummary,
	type LaunchdProbe,
	type LifeSummary,
	type MeetingSummary,
	PORTAL_SERVICE_LABELS,
	readCommunitySummary,
	readFathomSummary,
	readLifeSummary,
	readMeetingPublicationConfig,
	readMeetingSummary,
	readServiceHealth,
	readSkillsSummary,
	readWorkspaceSummary,
	resolveLifeOrchestratorSettings,
	stateTile,
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
import { readLearningSummary } from "./learning.ts";

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
}

export type PortalTiles = Readonly<Record<string, TileResult<unknown>>>;

export interface PortalSources {
	readonly today: () => PortalTiles;
	readonly health: () => PortalTiles;
	readonly connections: () => PortalTiles;
	readonly meetings: () => PortalTiles;
	readonly community: () => PortalTiles;
	readonly learning: () => PortalTiles;
	readonly workspace: () => PortalTiles;
}

const MAX_LIFE_CONFIG_BYTES = 1024 * 1024;

const lifeTiles = (options: PortalSourceOptions, homeRoot: string, now: Date): LifeSummary => {
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
	if (settings === undefined) {
		const state = refused === undefined ? "error" : "unsafe";
		const reason = refused ?? "life_settings_invalid";
		return {
			readings: stateTile(state, reason, now),
			brief: stateTile(state, reason, now),
			latestPreview: stateTile(state, reason, now),
			weeklyRuns: stateTile(state, reason, now),
			setup: stateTile(state, reason, now),
		};
	}
	return readLifeSummary(settings, { now, timeoutMs: options.timeoutMs });
};

/** Build the portal's sources. Each call reads afresh; the server caches the results. */
export const createPortalSources = (options: PortalSourceOptions): PortalSources => {
	const homeRoot = resolve(options.homeRoot);
	const configPath = join(homeRoot, ".jarvis", "config.yaml");
	const read = { timeoutMs: options.timeoutMs };

	const meeting = (now: Date): MeetingSummary => {
		const config = readMeetingPublicationConfig({ homeRoot, configPath, env: options.env, now });
		if (config.state !== "ok") {
			const failed = stateTile<never>(config.state, config.reason!, now);
			return { config: failed, queue: failed, providers: failed };
		}
		return readMeetingSummary(config.data!, { ...read, now });
	};
	const fathom = (now: Date): FathomSummary => readFathomSummary({ ...read, now, homeRoot, configPath });
	const community = (now: Date): CommunitySummary => readCommunitySummary({ ...read, now, homeRoot, configPath });

	return {
		today: () => {
			const now = options.clock();
			const life = lifeTiles(options, homeRoot, now);
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
			return {
				meeting: meetingConnections(meeting(now), now),
				fathom: fathomConnections(fathom(now), now),
				community: communityConnections(community(now), now),
				cockpit: cockpitConnections(now),
				googleWorkspace: googleWorkspaceConnections(homeRoot, now),
				codex: codexConnections(homeRoot, now),
			};
		},
		meetings: () => {
			const now = options.clock();
			const meetings = meeting(now);
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
	};
};
