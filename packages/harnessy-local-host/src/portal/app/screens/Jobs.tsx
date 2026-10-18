/**
 * Jobs: every launchd job and service, with its schedule, next run (Africa/Lagos),
 * launchd state and loopback liveness. Controls are commands to copy or links to
 * the owning service. The community review service is never paused from here.
 */
import { ActionList } from "../components/actions.tsx";
import { DetailPane } from "../components/DetailPane.tsx";
import { Card, StatusDot, WithTile } from "../components/primitives.tsx";
import { ScreenHeader } from "../components/Shell.tsx";
import type { Job, JobsResponse } from "../lib/api-types.ts";
import { useResource } from "../lib/data.tsx";
import { dateTime, relativeTime } from "../lib/format.ts";
import { routeHref } from "../lib/router.ts";
import { JOB_TONE } from "./Today.tsx";

const KIND_LABEL: Readonly<Record<Job["kind"], string>> = {
	timed: "timed",
	service: "service",
	"on-demand": "on demand",
};

const JobDetail = ({ job, now }: { job: Job; now: number }) => (
	<>
		<p className="label">
			{KIND_LABEL[job.kind]}
			{job.label === null ? "" : ` · ${job.label}`}
		</p>
		<h2 className="detail-title">{job.name}</h2>
		<StatusDot tone={JOB_TONE[job.health]} label={job.healthReason} pulse={job.pid !== null && job.health === "ok"} />
		{job.neverPause ? (
			<p className="banner banner-danger">
				Never paused, stopped or restarted from here. A loaded label without a process stops publication.
			</p>
		) : null}
		<dl className="facts">
			<dt>Schedule</dt>
			<dd>{job.schedule ?? "–"}</dd>
			<dt>Next run</dt>
			<dd>{job.nextRun === null ? "–" : `${dateTime(job.nextRun)} (${relativeTime(job.nextRun, now)})`}</dd>
			<dt>Last activity</dt>
			<dd>
				{job.lastActivity === null ? "–" : `${relativeTime(job.lastActivity.at, now)}`}
				{job.lastActivity === null ? null : <span className="muted"> (log mtime)</span>}
			</dd>
			<dt>launchd</dt>
			<dd>
				{job.loaded === null
					? (job.stateReason ?? "not checked")
					: job.loaded
						? (job.state ?? "loaded")
						: "not loaded"}
				{job.pid === null ? "" : ` · pid ${job.pid}`}
				{job.lastExitCode === null ? "" : ` · last exit ${job.lastExitCode}`}
				{job.lastLogCode === null ? "" : ` · last log ${job.lastLogCode}`}
			</dd>
			{job.port === null ? null : (
				<>
					<dt>Port</dt>
					<dd>
						{job.port}
						{job.liveness.map((probe) => (
							<span key={probe.host} className="muted">
								{" "}
								· {probe.host} {probe.open ? "answering" : "closed"}
							</span>
						))}
					</dd>
				</>
			)}
		</dl>
		{job.notes.length === 0 ? null : (
			<ul className="notes">
				{job.notes.map((note) => (
					<li key={note}>{note}</li>
				))}
			</ul>
		)}
		{job.programArguments === null ? null : (
			<>
				<p className="label">Program arguments (environment omitted, possible secrets redacted)</p>
				<pre className="code-block">
					<code>{job.programArguments.join(" \\\n  ")}</code>
				</pre>
			</>
		)}
		<ActionList actions={job.controls} />
	</>
);

export const JobsScreen = ({ rest, now }: { rest: ReadonlyArray<string>; now: number }) => {
	const jobs = useResource<JobsResponse>("/v1/jobs");
	return (
		<div className="screen">
			<ScreenHeader title="Jobs">
				<p className="text-2">
					Times are Africa/Lagos. Last activity is a log file's modified time until run records exist.
				</p>
			</ScreenHeader>
			{jobs.status === "loading" ? <p className="muted">Loading</p> : null}
			<WithTile tile={jobs.data?.tiles.jobs}>
				{(data) => {
					const selected = data.jobs.find((job) => job.id === rest[0]) ?? data.jobs[0];
					return (
						<div className="split">
							<div className="table-scroll card">
								<table className="table">
									<thead>
										<tr>
											<th scope="col">Job</th>
											<th scope="col">Kind</th>
											<th scope="col">Schedule / port</th>
											<th scope="col">Next run</th>
											<th scope="col">State</th>
										</tr>
									</thead>
									<tbody>
										{data.jobs.map((job) => (
											<tr key={job.id} className={job.id === selected?.id ? "row-selected" : undefined}>
												<td>
													<a href={routeHref("jobs", job.id)}>{job.name}</a>
												</td>
												<td className="text-2">{KIND_LABEL[job.kind]}</td>
												<td className="mono text-2">
													{job.schedule ?? (job.port === null ? "–" : `port ${job.port}`)}
												</td>
												<td className="text-2">
													{job.nextRun === null ? "–" : relativeTime(job.nextRun, now)}
												</td>
												<td>
													<StatusDot tone={JOB_TONE[job.health]} label={job.healthReason} />
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							{selected === undefined ? null : (
								<DetailPane
									label={`${selected.name} detail`}
									open={rest[0] !== undefined && selected.id === rest[0]}
									onClose={() => window.location.replace(routeHref("jobs"))}
								>
									<JobDetail job={selected} now={now} />
								</DetailPane>
							)}
						</div>
					);
				}}
			</WithTile>
			<div className="grid">
				<Card title="Community weekly drafts">
					<WithTile tile={jobs.data?.tiles.communityGeneration}>
						{(generation) => (
							<>
								<p className="text-2">
									{generation.nextRun === null
										? "No next run known."
										: `Next draft ${dateTime(generation.nextRun)}.`}
								</p>
								{generation.standingFault === null ? null : (
									<p className="tone-danger">
										Stuck: {generation.standingFault.code} since {generation.standingFault.since}
									</p>
								)}
								<ul className="plain-list">
									{generation.weeks.slice(0, 5).map((week) => (
										<li key={week.weekStart} className="split-line">
											<span>Week of {week.weekStart}</span>
											<StatusDot
												tone={week.status === "failed" ? "danger" : "ok"}
												label={`${week.status}${week.attempts > 1 ? ` · ${week.attempts} attempts` : ""}${week.code === null ? "" : ` · ${week.code}`}`}
											/>
										</li>
									))}
								</ul>
							</>
						)}
					</WithTile>
				</Card>
				<Card title="Fathom accounts">
					<WithTile tile={jobs.data?.tiles.fathomAccounts}>
						{(fathom) => (
							<ul className="plain-list">
								{fathom.accounts.map((account) => (
									<li key={account.account} className="split-line">
										<span>
											{account.account}
											<span className="muted">
												{" "}
												· {account.pending ?? "?"} in inbox
												{account.invalid ? ` · ${account.invalid} invalid` : ""}
											</span>
										</span>
										<StatusDot
											tone={account.stale ? "danger" : "ok"}
											label={
												account.updatedAt === null
													? "never polled"
													: `polled ${relativeTime(account.updatedAt, now)}`
											}
										/>
									</li>
								))}
							</ul>
						)}
					</WithTile>
				</Card>
			</div>
		</div>
	);
};
