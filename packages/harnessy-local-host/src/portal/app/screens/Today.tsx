/**
 * Today: the daily brief (parsed Markdown, no raw HTML) with its two action
 * sections pinned, a switcher for the last seven briefs, a weekly draft reader,
 * and what ran overnight. Readings are "in queue" or "sent in a brief": the
 * ledger has no read state, so the app never says "unread".
 */
import { CommandChip } from "../components/actions.tsx";
import { ErrorBoundary, PlainTextFallback } from "../components/ErrorBoundary.tsx";
import { Card, StatusDot, TileState, type Tone, WithTile } from "../components/primitives.tsx";
import { MarkdownBlocks, SafeMarkdown } from "../components/SafeMarkdown.tsx";
import { ScreenHeader } from "../components/Shell.tsx";
import type { Job, JobsResponse, LifeBriefResponse, LifeWeeklyDraftResponse, TodayResponse } from "../lib/api-types.ts";
import { useResource } from "../lib/data.tsx";
import { dateTime, dayLabel, relativeTime } from "../lib/format.ts";
import { parseMarkdown, sectionsOf } from "../lib/markdown.ts";
import { routeHref } from "../lib/router.ts";

export const PINNED_SECTIONS = ["Decisions and Actions for You", "Delegated or Waiting"] as const;

export const JOB_TONE: Readonly<Record<Job["health"], Tone>> = {
	ok: "ok",
	attention: "attention",
	error: "danger",
	idle: "idle",
	unknown: "idle",
};

const Brief = ({ text }: { text: string }) => {
	const sections = sectionsOf(parseMarkdown(text));
	const pinned = PINNED_SECTIONS.map((title) =>
		sections.find((section) => section.title?.toLowerCase() === title.toLowerCase()),
	);
	const rest = sections.filter((section) => !pinned.includes(section));
	return (
		<div className="markdown">
			{pinned.map((section, index) =>
				section === undefined ? null : (
					<Card key={PINNED_SECTIONS[index]} title={PINNED_SECTIONS[index]} className="card-raised">
						<MarkdownBlocks blocks={section.blocks} />
					</Card>
				),
			)}
			{rest.map((section, index) => (
				<section key={`${section.title ?? "intro"}-${index}`}>
					{section.title === null ? null : <h2 className="md-section">{section.title}</h2>}
					<MarkdownBlocks blocks={section.blocks} />
				</section>
			))}
		</div>
	);
};

const WeeklyDraft = ({ runHash }: { runHash: string }) => {
	const draft = useResource<LifeWeeklyDraftResponse>(
		/^[a-f0-9]{64}$/u.test(runHash) ? `/v1/life/weekly/${runHash}/draft` : null,
	);
	return (
		<article className="card article">
			<a className="back-link" href={routeHref("today")}>
				← Back to today
			</a>
			<WithTile tile={draft.data?.tiles.draft}>
				{(data) => (
					<>
						<h1 className="screen-title">Weekly plan draft · {data.periodId}</h1>
						<p className="muted">
							Read-only. Reconcile it with{" "}
							<code className="inline-code">harnessy jarvis life weekly-reconcile</code> when you are done.
						</p>
						{data.truncated ? <p className="tone-attention">Only the first 64 KiB are shown.</p> : null}
						<SafeMarkdown text={data.text} />
					</>
				)}
			</WithTile>
			{draft.status === "loading" ? <p className="muted">Loading</p> : null}
		</article>
	);
};

export const TodayScreen = ({ rest, now }: { rest: ReadonlyArray<string>; now: number }) =>
	rest[0] === "draft" && rest[1] !== undefined ? (
		<WeeklyDraft runHash={rest[1]} />
	) : (
		<TodayBrief
			date={rest[0] !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(rest[0]) ? rest[0] : undefined}
			now={now}
		/>
	);

const TodayBrief = ({ date, now }: { date: string | undefined; now: number }) => {
	const brief = useResource<LifeBriefResponse>(date === undefined ? "/v1/life/brief" : `/v1/life/brief/${date}`);
	const today = useResource<TodayResponse>("/v1/today");
	const jobs = useResource<JobsResponse>("/v1/jobs");
	const briefTile = brief.data?.tiles.brief;
	const dates = brief.data?.tiles.dates;
	const overnight =
		jobs.data?.tiles.jobs.state === "ok"
			? (jobs.data.tiles.jobs.data?.jobs ?? []).filter((job) =>
					["learning-research", "daily-brief", "weekly-plan"].includes(job.id),
				)
			: [];
	return (
		<div className="screen">
			<ScreenHeader
				title={
					briefTile?.state === "ok" && briefTile.data !== undefined
						? `Daily brief · ${dayLabel(briefTile.data.date)}`
						: "Today"
				}
			>
				{dates?.state === "ok" && dates.data !== undefined && dates.data.dates.length > 0 ? (
					<nav className="date-switcher" aria-label="Recent briefs">
						{dates.data.dates.map((entry) => {
							const current =
								(date ?? (briefTile?.state === "ok" ? briefTile.data?.date : undefined)) === entry.date;
							return (
								<a
									key={entry.date}
									href={routeHref("today", entry.date)}
									className={current ? "chip chip-current" : "chip"}
									aria-current={current ? "page" : undefined}
								>
									{dayLabel(entry.date)}
								</a>
							);
						})}
					</nav>
				) : null}
			</ScreenHeader>
			<div className="columns">
				<article className="card article column-main">
					{briefTile?.state === "ok" && briefTile.data !== undefined ? (
						<>
							<div className="badge-row">
								{briefTile.data.journaled ? (
									<span className="pill pill-ok">journaled</span>
								) : (
									<span className="pill">not journaled</span>
								)}
								{briefTile.data.truncated ? <span className="pill pill-attention">first 64 KiB</span> : null}
							</div>
							<ErrorBoundary
								fallback={<PlainTextFallback text={briefTile.data.text} />}
								resetKey={briefTile.data.text}
							>
								<Brief text={briefTile.data.text} />
							</ErrorBoundary>
						</>
					) : brief.status === "loading" ? (
						<p className="muted">Loading</p>
					) : (
						<TileState tile={briefTile} />
					)}
				</article>
				<div className="column-side">
					<Card title="Overnight">
						{overnight.length === 0 ? <p className="muted">No job data</p> : null}
						<ul className="plain-list">
							{overnight.map((job) => (
								<li key={job.id} className="split-line">
									<span>
										{job.name}
										{job.schedule === null ? null : <span className="muted"> · {job.schedule}</span>}
									</span>
									<StatusDot tone={JOB_TONE[job.health]} label={job.healthReason} />
								</li>
							))}
						</ul>
						{overnight.some((job) => job.lastActivity !== null) ? (
							<p className="fine-print">Last activity is the log file's modified time, not a run record.</p>
						) : null}
					</Card>
					<Card title="Reading queue">
						<WithTile tile={today.data?.tiles.readings}>
							{(readings) => (
								<div className="stats stats-inline">
									<div className="stat">
										<div className="stat-value">{readings.available}</div>
										<div className="stat-label">in queue</div>
									</div>
									<div className="stat">
										<div className="stat-value">{readings.delivered}</div>
										<div className="stat-label">sent in a brief</div>
									</div>
									{readings.reserved > 0 ? (
										<div className="stat">
											<div className="stat-value">{readings.reserved}</div>
											<div className="stat-label">reserved</div>
										</div>
									) : null}
								</div>
							)}
						</WithTile>
					</Card>
					<Card title="Weekly plans">
						<WithTile tile={today.data?.tiles.weeklyRuns}>
							{(weekly) =>
								weekly.runs.length === 0 ? (
									<p className="muted">No weekly runs yet.</p>
								) : (
									<ul className="plain-list">
										{weekly.runs.slice(0, 4).map((run) => (
											<li key={run.runHash} className="split-line">
												{run.state === "drafted" ? (
													<a href={routeHref("today", "draft", run.runHash)}>{run.periodId}</a>
												) : (
													<span>{run.periodId}</span>
												)}
												<StatusDot
													tone={
														run.state === "reconciled"
															? "ok"
															: run.state === "drafted"
																? "attention"
																: "danger"
													}
													label={run.state}
												/>
											</li>
										))}
									</ul>
								)
							}
						</WithTile>
					</Card>
					<Card title="Setup">
						<WithTile tile={today.data?.tiles.setup}>
							{(setup) => (
								<ul className="plain-list">
									<li className="split-line">
										<span>Learning steering</span>
										<StatusDot
											tone={setup.steeringReady ? "ok" : "attention"}
											label={setup.steeringReady ? "ready" : "missing"}
										/>
									</li>
									<li className="split-line">
										<span>Compatibility scripts</span>
										<StatusDot
											tone={setup.compatibilityReady ? "ok" : "attention"}
											label={setup.compatibilityReady ? "ready" : "missing"}
										/>
									</li>
								</ul>
							)}
						</WithTile>
					</Card>
					<Card title="Re-run the brief">
						<CommandChip
							command="harnessy jarvis life daily --max-output-bytes 1048576"
							note="Spends AI budget."
						/>
					</Card>
					{brief.fetchedAt === undefined ? null : (
						<p className="fine-print">
							Brief read {relativeTime(new Date(brief.fetchedAt).toISOString(), now)}; generated{" "}
							{dateTime(brief.data?.generatedAt)}.
						</p>
					)}
				</div>
			</div>
		</div>
	);
};
