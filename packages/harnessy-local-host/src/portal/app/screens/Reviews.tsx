/**
 * Reviews › Meetings and Reviews › Community. Both are link-outs: approving,
 * rejecting, archiving, editing and publishing stay on each service's own page.
 * The app never posts to 8770 or 8872.
 */
import { CommandChip, HandoffButton } from "../components/actions.tsx";
import { Card, Stat, StatusDot, WithTile } from "../components/primitives.tsx";
import { ScreenHeader } from "../components/Shell.tsx";
import type { CommunityResponse, JobsResponse, MeetingsResponse } from "../lib/api-types.ts";
import { useResource } from "../lib/data.tsx";
import { dayLabel } from "../lib/format.ts";
import { safeHref } from "../lib/safe-href.ts";

/** The review page in the address family its service listens on (`::1` is `[::1]` in a URL). */
export const reviewLink = (host: string | null | undefined, port: number | null | undefined) =>
	typeof port !== "number"
		? undefined
		: host === "::1"
			? safeHref(`http://[::1]:${port}/`)
			: host === "127.0.0.1" || host === "localhost"
				? safeHref(`http://${host}:${port}/`)
				: undefined;

/**
 * The exact opener command from the Jobs list, which knows each service's state
 * path. `undefined` while that path is unknown: a command with a placeholder is
 * never offered as if it could be run.
 */
export const openerOf = (jobs: JobsResponse | undefined, id: string): string | undefined => {
	const target =
		jobs?.tiles.jobs.state === "ok"
			? jobs.tiles.jobs.data?.jobs
					.find((job) => job.id === id)
					?.controls.find((control) => control.kind === "copy" && control.label === "Open with a session")?.target
			: undefined;
	return target === undefined || /<[^>]*>/u.test(target) ? undefined : target;
};

const Opener = ({ command }: { command: string | undefined }) =>
	command === undefined ? (
		<p className="fine-print">
			The opener command appears here once the service's state path is known. The Jobs screen shows its state.
		</p>
	) : (
		<CommandChip command={command} note="Use this when the review page asks for a session." />
	);

export const ReviewsScreen = ({ rest }: { rest: ReadonlyArray<string> }) => {
	const only = rest[0] === "meetings" || rest[0] === "community" ? rest[0] : undefined;
	const meetings = useResource<MeetingsResponse>("/v1/meetings/summary");
	const community = useResource<CommunityResponse>("/v1/community/summary");
	const jobs = useResource<JobsResponse>("/v1/jobs");
	const meetingConfig = meetings.data?.tiles.config.state === "ok" ? meetings.data.tiles.config.data : undefined;
	const communityConfig = community.data?.tiles.config.state === "ok" ? community.data.tiles.config.data : undefined;
	const meetingLink = reviewLink(meetingConfig?.reviewHost, meetingConfig?.reviewPort);
	const communityLink = reviewLink(communityConfig?.reviewHost, communityConfig?.reviewPort);
	return (
		<div className="screen">
			<ScreenHeader
				title={only === "meetings" ? "Meeting reviews" : only === "community" ? "Community reviews" : "Reviews"}
			/>
			<p className="banner banner-danger">
				Never run <code className="inline-code">jarvis community briefing …</code> while publication runs.
			</p>
			<div className="grid">
				{only === "community" ? null : (
					<Card title="Meetings">
						<WithTile tile={meetings.data?.tiles.queue}>
							{(queue) => (
								<div className="stats stats-inline">
									<Stat value={queue.statusCounts.pending_review ?? 0} label="pending" />
									<Stat value={queue.statusCounts.published ?? 0} label="published" />
									<Stat value={queue.statusCounts.rejected ?? 0} label="rejected" />
									<Stat value={queue.statusCounts.archived ?? 0} label="archived" />
								</div>
							)}
						</WithTile>
						<WithTile tile={meetings.data?.tiles.providers}>
							{(providers) => (
								<ul className="plain-list">
									{providers.providers.map((provider) => (
										<li key={provider.provider} className="split-line">
											<span>{provider.provider === "google" ? "Google" : "Discord"}</span>
											<StatusDot
												tone={provider.failure === null ? "ok" : "danger"}
												label={provider.failure === null ? "connected" : provider.failure}
											/>
										</li>
									))}
								</ul>
							)}
						</WithTile>
						<p className="text-2">Approve and publish on the meeting review page.</p>
						{meetingLink === undefined ? null : (
							<HandoffButton
								action={{ kind: "handoff", label: "Open meeting review", target: meetingLink, note: null }}
								primary
							/>
						)}
						<Opener command={openerOf(jobs.data, "meeting-publication")} />
					</Card>
				)}
				{only === "meetings" ? null : (
					<Card title="Community briefings">
						<WithTile tile={community.data?.tiles.queue}>
							{(queue) => (
								<ul className="plain-list">
									{queue.recent.map((week) => (
										<li key={week.weekStart} className="split-line">
											<span>Week of {dayLabel(week.weekStart)}</span>
											<StatusDot
												tone={
													week.status === "pending_review"
														? "danger"
														: week.errorStage === null
															? "ok"
															: "attention"
												}
												label={`${week.status === "pending_review" ? "waiting for you" : week.status}${week.attempts > 1 ? ` · ${week.attempts} attempts` : ""}${week.errorStage === null ? "" : ` · ${week.errorStage}`}`}
											/>
										</li>
									))}
								</ul>
							)}
						</WithTile>
						<WithTile tile={community.data?.tiles.generation}>
							{(generation) => (
								<p className="text-2">
									Weekly drafts:{" "}
									{generation.schedule === null
										? "schedule unknown"
										: `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][generation.schedule.weekday]} ${String(generation.schedule.hour).padStart(2, "0")}:${String(generation.schedule.minute).padStart(2, "0")} ${generation.schedule.timezone}`}
									{generation.lastFailure === null ? "" : ` · last failure ${generation.lastFailure.code}`}
								</p>
							)}
						</WithTile>
						{communityLink === undefined ? null : (
							<HandoffButton
								action={{ kind: "handoff", label: "Open community review", target: communityLink, note: null }}
								primary
							/>
						)}
						<Opener command={openerOf(jobs.data, "community-review")} />
					</Card>
				)}
			</div>
		</div>
	);
};
