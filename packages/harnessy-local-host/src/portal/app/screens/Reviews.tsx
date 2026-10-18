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

const loopback = (host: string | null | undefined, port: number | null | undefined) =>
	(host === "127.0.0.1" || host === "localhost") && typeof port === "number"
		? safeHref(`http://127.0.0.1:${port}/`)
		: undefined;

/** The exact opener command from the Jobs list, which knows each service's state path. */
const openerOf = (jobs: JobsResponse | undefined, id: string, fallback: string): string =>
	(jobs?.tiles.jobs.state === "ok"
		? jobs.tiles.jobs.data?.jobs
				.find((job) => job.id === id)
				?.controls.find((control) => control.kind === "copy" && control.label === "Open with a session")?.target
		: undefined) ?? fallback;

export const ReviewsScreen = () => {
	const meetings = useResource<MeetingsResponse>("/v1/meetings/summary");
	const community = useResource<CommunityResponse>("/v1/community/summary");
	const jobs = useResource<JobsResponse>("/v1/jobs");
	const meetingConfig = meetings.data?.tiles.config.state === "ok" ? meetings.data.tiles.config.data : undefined;
	const communityConfig = community.data?.tiles.config.state === "ok" ? community.data.tiles.config.data : undefined;
	const meetingLink = loopback(meetingConfig?.reviewHost, meetingConfig?.reviewPort);
	const communityLink = loopback(communityConfig?.reviewHost, communityConfig?.reviewPort);
	return (
		<div className="screen">
			<ScreenHeader title="Reviews" />
			<p className="banner banner-danger">
				Never run <code className="inline-code">jarvis community briefing …</code> while publication runs.
			</p>
			<div className="grid">
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
					<CommandChip
						command={openerOf(
							jobs.data,
							"meeting-publication",
							"harnessy-meeting-review-open --state-path <state path>",
						)}
						note="Use this when the review page asks for a session."
					/>
				</Card>
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
					<CommandChip
						command={openerOf(
							jobs.data,
							"community-review",
							"harnessy-community-review-open --state-path <state path>",
						)}
						note="Use this when the review page asks for a session."
					/>
				</Card>
			</div>
		</div>
	);
};
