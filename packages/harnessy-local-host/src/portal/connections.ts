/**
 * Connection status: one row per credential holder, with a hand-off to the
 * service that owns the credential. The portal never runs OAuth, never reads a
 * credential file and never runs an action: a `link` opens the owning service's
 * page and a `command` is text for Julian to copy.
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";

import {
	type CommunitySummary,
	type ConnectionData,
	type ConnectionListData,
	type FathomSummary,
	guardTile,
	type MeetingSummary,
	okTile,
	ReadModelStateError,
	readBoundedDirectory,
	stateTile,
	type TileResult,
} from "@harnessy/core/read-model";

export const MAX_GWS_PROFILES = 32;
/** The most rows one connection tile carries (`ConnectionListSchema` allows 64); the rest are counted in `omitted`. */
export const MAX_CONNECTIONS = 64;
const GWS_PROFILE = /^gws-([A-Za-z0-9][A-Za-z0-9._-]{0,47})$/u;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

export const MEETING_RECONNECT_NOTE =
	"If it says session, run harnessy-meeting-review-open, then Reconnect Google under Provider health.";

type ConnectionTile = TileResult<ConnectionListData>;

const list = (connections: ReadonlyArray<ConnectionData>, now: Date, omitted = 0): ConnectionTile =>
	okTile({ connections: [...connections], omitted }, now);

/** Only a loopback review service gets a link, and the link always names 127.0.0.1. */
const reviewLink = (host: string | null, port: number | null): string | null =>
	host !== null && port !== null && LOOPBACK_HOSTS.has(host) && port > 0 && port <= 65_535
		? `http://127.0.0.1:${port}/`
		: null;

/** Carry a degraded source tile's state and reason over to its connection tile. */
const passState = <A>(tile: TileResult<A>, now: Date): ConnectionTile =>
	stateTile(tile.state as Exclude<typeof tile.state, "ok">, tile.reason!, now);

export const meetingConnections = (summary: MeetingSummary, now: Date): ConnectionTile => {
	if (summary.config.state !== "ok") return passState(summary.config, now);
	const config = summary.config.data!;
	if (!config.enabled) return stateTile("missing", "meeting_disabled", now);
	if (summary.providers.state !== "ok") return passState(summary.providers, now);
	const href = reviewLink(config.reviewHost, config.reviewPort);
	const recorded = new Map(summary.providers.data!.providers.map((provider) => [provider.provider, provider]));
	return list(
		(["google", "discord"] as const).map((provider) => {
			const health = recorded.get(provider);
			return {
				id: `meeting.${provider}`,
				label: provider === "google" ? "Meeting publication: Google" : "Meeting publication: Discord",
				owner: "meeting-publication",
				status: health === undefined ? "unknown" : health.failure === null ? "connected" : "attention",
				detail: health === undefined ? "not_checked" : health.failure,
				checkedAt: health?.checkedAt ?? null,
				action:
					href === null
						? null
						: {
								kind: "link",
								value: href,
								note:
									provider === "google" ? MEETING_RECONNECT_NOTE : "Open Provider health on the review page.",
							},
			};
		}),
		now,
	);
};

export const fathomConnections = (summary: FathomSummary, now: Date): ConnectionTile => {
	if (summary.checkpoint.state !== "ok") return passState(summary.checkpoint, now);
	const accounts = summary.checkpoint.data!.accounts;
	return list(
		accounts.slice(0, MAX_CONNECTIONS).map((account) => ({
			id: `fathom.${account.account}`.slice(0, 96),
			label: `Fathom: ${account.account}`.slice(0, 96),
			owner: "fathom-poll",
			status: account.stale ? "attention" : "connected",
			detail: account.updatedAt === null ? "never_polled" : account.stale ? "checkpoint_stale" : null,
			checkedAt: account.updatedAt,
			action: { kind: "command", value: "harnessy jarvis meeting fathom status", note: null },
		})),
		now,
		accounts.length - Math.min(accounts.length, MAX_CONNECTIONS),
	);
};

export const communityConnections = (summary: CommunitySummary, now: Date): ConnectionTile => {
	if (summary.config.state !== "ok") return passState(summary.config, now);
	const config = summary.config.data!;
	const href = reviewLink(config.reviewHost, config.reviewPort);
	const action = href === null ? null : ({ kind: "link", value: href, note: null } as const);
	return list(
		[
			{
				id: "community.google",
				label: "Community briefing: Google",
				owner: "community-review",
				status: "not_tracked",
				detail: null,
				checkedAt: null,
				action,
			},
			{
				id: "community.discord",
				label: "Community briefing: Discord",
				owner: "community-review",
				status: config.discordChannelConfigured ? "not_tracked" : "not_configured",
				detail: config.discordChannelConfigured ? "configured" : null,
				checkedAt: null,
				action,
			},
		],
		now,
	);
};

export const cockpitConnections = (now: Date): ConnectionTile =>
	list(
		[
			{
				id: "cockpit.integrations",
				label: "Cockpit integrations",
				owner: "cockpit",
				status: "not_tracked",
				detail: "held_by_cockpit",
				checkedAt: null,
				action: { kind: "command", value: "harnessy web", note: null },
			},
		],
		now,
	);

/** `gws-<slug>` profile directories under `<home>/.config`. Names only; no file inside is opened. */
export const googleWorkspaceConnections = (homeRoot: string, now: Date): ConnectionTile =>
	guardTile(now, () => {
		const listing = readBoundedDirectory(join(homeRoot, ".config"), 2_000, true);
		if (listing.truncated) return stateTile("unsupported", "scan_limit", now);
		const slugs = listing.entries
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => GWS_PROFILE.exec(entry.name)?.[1])
			.filter((slug): slug is string => slug !== undefined)
			.sort();
		return list(
			slugs.slice(0, MAX_GWS_PROFILES).map((slug) => ({
				id: `gws.${slug}`,
				label: `Google Workspace CLI: ${slug}`,
				owner: "gws",
				status: "unknown",
				detail: "profile_present",
				checkedAt: null,
				action: { kind: "command", value: `gws-login ${slug}`, note: `Check with gws-status ${slug}.` },
			})),
			now,
			Math.max(0, slugs.length - MAX_GWS_PROFILES),
		);
	});

/** Codex sign-in: the presence of the auth file only. The file is never opened. */
export const codexConnections = (homeRoot: string, now: Date): ConnectionTile =>
	guardTile(now, () => {
		const stat = lstatSync(join(homeRoot, ".codex", "auth.json"), { throwIfNoEntry: false });
		if (stat !== undefined && !stat.isFile()) throw new ReadModelStateError("unsafe", "file_not_regular");
		return list(
			[
				{
					id: "codex",
					label: "Codex",
					owner: "codex",
					status: stat === undefined ? "not_configured" : "unknown",
					detail: stat === undefined ? "auth_file_missing" : "auth_file_present",
					checkedAt: null,
					action: { kind: "command", value: "codex login", note: null },
				},
			],
			now,
		);
	});
