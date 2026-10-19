/**
 * The Inbox: one ranked list of what needs Julian, across every service.
 *
 * It is a pure function of tiles the other routes already read. The server
 * decides each item's severity; the browser only displays it. Severities follow
 * Garden's vocabulary: `action_required` (only Julian can clear it),
 * `attention` (worth a look) and `info`. Each item has a stable key, names the
 * service that owns the fix, and offers only a hand-off or a command to copy.
 *
 * Readings are never called "unread": the reading ledger has no read state.
 */
import type {
	AppActionData,
	CommunityConfigData,
	CommunityGenerationData,
	CommunityQueueData,
	ConnectionListData,
	FathomAccountsData,
	InboxItemData,
	InboxListData,
	JobListData,
	LifeWeeklyRunsData,
	MeetingConfigData,
	MeetingQueueData,
	TileResult,
} from "@harnessy/core/read-model";

import { fathomConnectionId } from "./connections.ts";
import { HIDDEN_CHARACTERS, LAUNCHD_UNAVAILABLE, reviewUrl, shellPath } from "./jobs.ts";

export interface InboxInputs {
	readonly now: Date;
	readonly weeklyRuns: TileResult<LifeWeeklyRunsData>;
	/** Count of items in today's brief "Decisions and Actions for You", or `null` without a brief. */
	readonly briefDecisions: { readonly date: string; readonly count: number } | null;
	readonly meetingConfig: TileResult<MeetingConfigData>;
	readonly meetingQueue: TileResult<MeetingQueueData>;
	readonly meetingStatePath: string | null;
	readonly communityConfig: TileResult<CommunityConfigData>;
	readonly communityQueue: TileResult<CommunityQueueData>;
	readonly communityGeneration: TileResult<CommunityGenerationData>;
	readonly communityStatePath: string | null;
	readonly fathomAccounts: TileResult<FathomAccountsData>;
	readonly workspaceRoot: string | null;
	readonly jobs: JobListData;
	readonly connections: Readonly<Record<string, TileResult<ConnectionListData>>>;
}

const RANK: Readonly<Record<InboxItemData["severity"], number>> = { action_required: 0, attention: 1, info: 2 };
const MAX_ITEMS = 100;

const copy = (label: string, target: string, note: string | null = null): AppActionData => ({
	kind: "copy",
	label,
	target,
	note,
});
const handoff = (label: string, target: string, note: string | null = null): AppActionData => ({
	kind: "handoff",
	label,
	target,
	note,
});

const instantOrNull = (value: string | null | undefined): string | null =>
	typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null;

const cut = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** Plain words for the reason codes a connection carries in `detail`. */
const CONNECTION_DETAIL_TEXT: Readonly<Record<string, string>> = {
	never_polled: "No successful poll recorded",
	checkpoint_stale: "No successful poll recently",
	not_checked: "Not checked yet",
	not_configured: "Not set up yet",
};

/** A connection's `detail` in plain words: a known code is translated, any other snake_case code is spelled out. */
export const connectionDetailText = (detail: string): string =>
	CONNECTION_DETAIL_TEXT[detail] ??
	(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(detail)
		? `${detail.charAt(0).toUpperCase()}${detail.slice(1).replaceAll("_", " ")}`
		: detail);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `24 Aug` for `2026-08-24`, independent of the runtime's locale data. */
const weekLabel = (weekStart: string): string => {
	const match = /^\d{4}-(\d{2})-(\d{2})$/u.exec(weekStart);
	const month = match === null ? undefined : MONTHS[Number(match[1]) - 1];
	return match === null || month === undefined ? weekStart : `${Number(match[2])} ${month}`;
};

/** Every inbox item for `inputs`, ranked action_required, attention, info and oldest first within each. */
export const deriveInbox = (inputs: InboxInputs): InboxListData => {
	const items: InboxItemData[] = [];
	const unreadable: string[] = [];
	const note = (name: string, tile: TileResult<unknown>) => {
		if (tile.state !== "ok" && tile.state !== "missing") unreadable.push(`${name}:${tile.reason ?? tile.state}`);
	};
	/** Index in `items` of the item that holds each problem, so one problem is one item. */
	const problems = new Map<string, number>();
	/**
	 * Add an item. Items that name the same `problem` (for example the same Fathom
	 * account seen by the poll checkpoint and by Connections) are one item: the one
	 * with the highest severity is kept, the first on a tie.
	 */
	const add = (
		item: Omit<InboxItemData, "title" | "context" | "detail"> & Record<"title" | "context" | "detail", string>,
		problem?: string,
	) => {
		const entry: InboxItemData = {
			...item,
			title: cut(item.title, 160),
			context: cut(item.context, 300),
			detail: cut(item.detail, 600),
		};
		const held = problem === undefined ? undefined : problems.get(problem);
		if (held === undefined) {
			if (problem !== undefined) problems.set(problem, items.length);
			items.push(entry);
		} else if (RANK[entry.severity] < RANK[items[held]!.severity]) items[held] = entry;
	};

	// Community briefings waiting for review.
	note("community.queue", inputs.communityQueue);
	const communityConfig = inputs.communityConfig.state === "ok" ? inputs.communityConfig.data! : null;
	const communityLink = reviewUrl(communityConfig?.reviewHost, communityConfig?.reviewPort);
	const communityOwner = {
		service: "community-review",
		port: communityConfig?.reviewPort ?? null,
		label: `community review${communityConfig?.reviewPort ? ` · ${communityConfig.reviewPort}` : ""}`,
	};
	const communityOpener = `harnessy-community-review-open --state-path ${
		inputs.communityStatePath === null ? "<state path>" : shellPath(inputs.communityStatePath, "<state path>")
	}`;
	if (inputs.communityQueue.state === "ok") {
		const queue = inputs.communityQueue.data!;
		const pending = queue.counts.pending_review ?? 0;
		if (pending > 0) {
			const weeks = queue.recent.filter((week) => week.status === "pending_review").map((week) => week.weekStart);
			const oldest = [...weeks].sort()[0];
			add({
				key: "community:pending",
				severity: "action_required",
				source: "community",
				title: pending === 1 ? "1 community briefing waiting" : `${pending} community briefings waiting`,
				context:
					weeks.length === 0
						? "Drafts are ready for review"
						: `Weeks of ${weeks.sort().map(weekLabel).join(", ")}${weeks.length < pending ? " and older" : ""}`,
				detail:
					"Drafts are ready for your review. Approve or reject them on the community review page; Harnessy never publishes.",
				since: oldest === undefined ? null : instantOrNull(`${oldest}T00:00:00Z`),
				owner: communityOwner,
				actions: [
					...(communityLink === null ? [] : [handoff("Open community review", communityLink)]),
					copy("Copy opener", communityOpener, "Opens the review page with a fresh session."),
				],
			});
		}
	}

	// Weekly community draft generation.
	note("community.generation", inputs.communityGeneration);
	if (inputs.communityGeneration.state === "ok") {
		const generation = inputs.communityGeneration.data!;
		const status = copy("Check status", "harnessy jarvis community generation-status", "Read-only.");
		if (generation.standingFault !== null)
			add({
				key: "community-generation:fault",
				severity: "action_required",
				source: "community",
				title: "Weekly community drafts are stuck",
				context: `Fault ${generation.standingFault.code} since ${generation.standingFault.since}`,
				detail:
					"Each scheduled tick fails the same way until the fault clears. Check the status; repair only a damaged record with --repair.",
				since: instantOrNull(generation.standingFault.since),
				owner: communityOwner,
				actions: [status],
			});
		const failure = generation.lastFailure;
		const week =
			failure === null ? undefined : generation.weeks.find((entry) => entry.weekStart === failure.weekStart);
		// A standing fault already covers its failed week: one item, at action_required, not two.
		if (
			generation.standingFault === null &&
			failure !== null &&
			week?.recovered !== true &&
			week?.status !== "created" &&
			week?.status !== "existing"
		)
			add({
				key: `community-generation:${failure.weekStart}`,
				severity: "attention",
				source: "community",
				title: `Weekly community draft failed for ${weekLabel(failure.weekStart)}`,
				context: `${failure.code} after ${failure.attempts} attempt${failure.attempts === 1 ? "" : "s"}${week?.gaveUp ? " (gave up)" : ""}`,
				detail:
					generation.nextRun === null
						? "The review service records each attempt. Check the status before retrying."
						: `The next scheduled draft runs at ${generation.nextRun}. Check the status before then.`,
				since: instantOrNull(failure.at),
				owner: communityOwner,
				actions: [status],
			});
	}

	// Life weekly runs: the newest draft is ready to read; every other open run needs a decision.
	note("life.weeklyRuns", inputs.weeklyRuns);
	if (inputs.weeklyRuns.state === "ok") {
		const runs = inputs.weeklyRuns.data!.runs;
		const newestDraft = runs.find((run) => run.state === "drafted");
		for (const run of runs) {
			if (run.state === "reconciled") continue;
			const reconcile = copy(
				"Copy reconcile",
				`harnessy jarvis life weekly-reconcile --run ${run.runHash} --reason "…"`,
				"Irreversible. Replace … with your reason.",
			);
			const lifeOwner = { service: "life-orchestrator", port: null, label: "Life orchestrator" };
			if (run === newestDraft && !run.incompleteReconciliation) {
				add({
					key: `life-weekly:${run.periodId}:draft`,
					severity: "attention",
					source: "life",
					title: `${run.periodId.slice(5)} weekly plan draft ready`,
					context: "Read the draft before the next plan",
					detail:
						"A drafted weekly plan is waiting. Read it here; reconcile it with the command when you are done.",
					since: null,
					owner: lifeOwner,
					actions: [handoff("Read draft", `#/today/draft/${run.runHash}`), reconcile],
				});
				continue;
			}
			add({
				key: `life-weekly:${run.periodId}`,
				severity: run.state === "unrecorded" ? "attention" : "action_required",
				source: "life",
				title: `Reconcile weekly run ${run.periodId.slice(5)}`,
				context: run.incompleteReconciliation
					? "Its reconciliation record is incomplete"
					: run.state === "unrecorded"
						? "Reserved without an outcome: still running, or it crashed"
						: `The run is ${run.state} and still blocks its period`,
				detail:
					"An unreconciled weekly run blocks a new run for its period. Inspect it, then record a decision with a short reason.",
				since: null,
				owner: lifeOwner,
				actions: [reconcile],
			});
		}
	}

	// Decisions in today's brief.
	if (inputs.briefDecisions !== null && inputs.briefDecisions.count > 0)
		add({
			key: `life-brief:${inputs.briefDecisions.date}:decisions`,
			severity: "attention",
			source: "life",
			title:
				inputs.briefDecisions.count === 1
					? "1 decision in today's brief"
					: `${inputs.briefDecisions.count} decisions in today's brief`,
			context: "Decisions and actions for you",
			detail: "Today's brief lists decisions and actions only you can take.",
			since: null,
			owner: { service: "life-orchestrator", port: null, label: "Life orchestrator" },
			actions: [handoff("Open Today", "#/today")],
		});

	// Meetings waiting for review.
	note("meetings.queue", inputs.meetingQueue);
	const meetingConfig = inputs.meetingConfig.state === "ok" ? inputs.meetingConfig.data! : null;
	if (inputs.meetingQueue.state === "ok") {
		const queue = inputs.meetingQueue.data!;
		const pending = queue.statusCounts.pending_review ?? 0;
		const link = reviewUrl(meetingConfig?.reviewHost, meetingConfig?.reviewPort);
		if (pending > 0)
			add({
				key: "meetings:pending",
				severity: "action_required",
				source: "meetings",
				title: pending === 1 ? "1 meeting note waiting" : `${pending} meeting notes waiting`,
				context: queue.pendingReview
					.slice(0, 5)
					.map((item) => item.meetingDate)
					.join(", "),
				detail: "Approve or reject them on the meeting review page; Harnessy never publishes.",
				since: instantOrNull(queue.pendingReview.map((item) => item.updatedAt).sort()[0]),
				owner: {
					service: "meeting-publication",
					port: meetingConfig?.reviewPort ?? null,
					label: `meeting review${meetingConfig?.reviewPort ? ` · ${meetingConfig.reviewPort}` : ""}`,
				},
				actions: [
					...(link === null ? [] : [handoff("Open meeting review", link)]),
					copy(
						"Copy opener",
						`harnessy-meeting-review-open --state-path ${
							inputs.meetingStatePath === null
								? "<state path>"
								: shellPath(inputs.meetingStatePath, "<state path>")
						}`,
						"Opens the review page with a fresh session.",
					),
				],
			});
	}

	// Fathom accounts.
	note("fathom.accounts", inputs.fathomAccounts);
	if (inputs.fathomAccounts.state === "ok") {
		const fathom = inputs.fathomAccounts.data!;
		const target = inputs.workspaceRoot === null ? "<workspace>" : shellPath(inputs.workspaceRoot, "<workspace>");
		const poll = copy("Copy poll", `harnessy jarvis meeting fathom poll --target ${target} --json`);
		const owner = { service: "fathom-poll", port: null, label: "Fathom poll" };
		let pending = 0;
		for (const account of fathom.accounts) {
			pending += account.pending ?? 0;
			if (account.stale)
				add(
					{
						key: `fathom:${account.account}:stale`,
						severity: "action_required",
						source: "fathom",
						title: `Fathom (${account.account}) has not polled recently`,
						context:
							account.ageSeconds === null
								? "No successful poll recorded"
								: `Last successful poll ${Math.round(account.ageSeconds / 60)} min ago (every ${Math.round(fathom.intervalSeconds / 60)} min)`,
						detail:
							"The poll checkpoint is older than two intervals. Run a poll to see the error. Reauthorisation has no command yet.",
						since: account.updatedAt,
						owner,
						actions: [poll],
					},
					`connection:${fathomConnectionId(account.account)}`,
				);
			if ((account.invalid ?? 0) > 0)
				add({
					key: `fathom:${account.account}:invalid`,
					severity: "attention",
					source: "fathom",
					title: `Fathom (${account.account}) has ${account.invalid} invalid recording${account.invalid === 1 ? "" : "s"}`,
					context: "Moved aside in the meeting inbox",
					detail: "These recordings could not be imported. Check them with the Fathom status command.",
					since: null,
					owner,
					actions: [copy("Copy status", "harnessy jarvis meeting fathom status")],
				});
		}
		if (pending > 0)
			add({
				key: "fathom:inbox",
				severity: "info",
				source: "fathom",
				title: pending === 1 ? "1 Fathom recording in the inbox" : `${pending} Fathom recordings in the inbox`,
				context: "Waiting to be turned into meeting notes",
				detail: "New recordings wait in the meeting inbox until the meeting workflow picks them up.",
				since: null,
				owner,
				actions: [copy("Copy status", "harnessy jarvis meeting fathom status")],
			});
	}

	// Jobs and services that are down. A supervised job whose launchd probe failed is not a
	// finding, but it is not "fine" either: it is reported as unreadable. (Where launchd does
	// not exist at all, there is nothing to read.)
	for (const job of inputs.jobs.jobs) {
		if (job.health === "unknown" && job.kind !== "on-demand" && job.healthReason !== LAUNCHD_UNAVAILABLE)
			unreadable.push(`jobs.${job.id}:${job.healthReason}`);
		if (job.health !== "error") continue;
		add({
			key: `job:${job.label ?? job.id}:${job.loaded === false ? "missing" : "failing"}`,
			severity: "action_required",
			source: "jobs",
			title: `${job.name}: ${job.healthReason}`,
			context: job.lastActivity === null ? "No recent log activity" : `Last log activity ${job.lastActivity.at}`,
			detail: job.neverPause
				? "This service is never stopped or restarted from Harnessy. Open its detail for the owning commands."
				: "Open the job's detail for its state and the commands that control it.",
			since: job.lastActivity?.at ?? null,
			owner: { service: job.id, port: job.port, label: job.name },
			actions: [handoff("Open job", `#/jobs/${job.id}`)],
		});
	}

	// Connections that need attention.
	for (const [group, tile] of Object.entries(inputs.connections)) {
		note(`connections.${group}`, tile);
		if (tile.state !== "ok") continue;
		for (const connection of tile.data!.connections) {
			if (connection.status !== "attention") continue;
			const action = connection.action;
			add(
				{
					key: `connection:${connection.id}`,
					severity: "attention",
					source: "connections",
					title: `${connection.label} needs attention`,
					context:
						connection.detail === null
							? "Reconnect it in the owning service"
							: connectionDetailText(connection.detail),
					detail: `Owned by ${connection.owner}. Harnessy never signs in for you.${action?.note ? ` ${action.note}` : ""}`,
					since: instantOrNull(connection.checkedAt),
					owner: { service: connection.owner, port: null, label: connection.owner },
					actions:
						action === null
							? [handoff("Open Connections", "#/connections")]
							: action.kind === "link"
								? [handoff("Open owner", action.value)]
								: // A command with hidden characters would not copy what it shows.
									HIDDEN_CHARACTERS.test(action.value)
									? [handoff("Open Connections", "#/connections")]
									: [copy("Copy command", action.value)],
				},
				`connection:${connection.id}`,
			);
		}
	}

	items.sort(
		(a, b) =>
			RANK[a.severity] - RANK[b.severity] ||
			(a.since === null ? 1 : 0) - (b.since === null ? 1 : 0) ||
			(a.since ?? "").localeCompare(b.since ?? "") ||
			a.key.localeCompare(b.key),
	);
	const nextJob = inputs.jobs.jobs
		.filter((job) => job.nextRun !== null && job.loaded !== false)
		.sort((a, b) => a.nextRun!.localeCompare(b.nextRun!))[0];
	const kept = items.slice(0, MAX_ITEMS);
	return {
		items: kept,
		counts: {
			action_required: kept.filter((item) => item.severity === "action_required").length,
			attention: kept.filter((item) => item.severity === "attention").length,
			info: kept.filter((item) => item.severity === "info").length,
		},
		nextJob: nextJob === undefined ? null : { name: nextJob.name, at: nextJob.nextRun! },
		unreadable: unreadable.slice(0, 32).map((value) => value.slice(0, 96)),
	};
};
