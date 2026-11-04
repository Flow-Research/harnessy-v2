/** Learning: the wiki catalog, the reading queue (labelled honestly) and the last research run. */
import { CommandChip, HandoffButton } from "../components/actions.tsx";
import { Card, Stat, StatusDot, WithTile } from "../components/primitives.tsx";
import { ScreenHeader } from "../components/Shell.tsx";
import type { JobsResponse, LearningResponse, TodayResponse } from "../lib/api-types.ts";
import { useResource } from "../lib/data.tsx";
import { relativeTime } from "../lib/format.ts";
import { JOB_TONE } from "./Today.tsx";

export const LearningScreen = ({ now }: { now: number }) => {
	const learning = useResource<LearningResponse>("/v1/learning/summary");
	const today = useResource<TodayResponse>("/v1/today");
	const jobs = useResource<JobsResponse>("/v1/jobs");
	const research =
		jobs.data?.tiles.jobs.state === "ok"
			? jobs.data.tiles.jobs.data?.jobs.find((job) => job.id === "learning-research")
			: undefined;
	const wiki =
		jobs.data?.tiles.jobs.state === "ok"
			? jobs.data.tiles.jobs.data?.jobs.find((job) => job.id === "learning-wiki")
			: undefined;
	return (
		<div className="screen">
			<ScreenHeader title="Learning" />
			<div className="grid">
				<Card title="Wiki catalog">
					<WithTile tile={learning.data?.tiles.catalog}>
						{(catalog) => (
							<div className="stats stats-inline">
								<Stat value={catalog.sources.total} label="sources" />
								<Stat value={catalog.sources.processed} label="processed" />
								<Stat value={catalog.sources.pending} label="pending" />
								<Stat
									value={catalog.sources.failed}
									label="failed"
									tone={catalog.sources.failed > 0 ? "attention" : undefined}
								/>
								<Stat value={catalog.pages} label="pages" />
							</div>
						)}
					</WithTile>
					{wiki === undefined ? null : (
						<p>
							<StatusDot tone={JOB_TONE[wiki.health]} label={`Wiki viewer: ${wiki.healthReason}`} />
						</p>
					)}
					<HandoffButton
						action={{ kind: "handoff", label: "Open the wiki", target: "http://127.0.0.1:4321/", note: null }}
						primary
					/>
					<p className="label">Add a page</p>
					<CommandChip
						command="learning ingest <url>"
						note="Replace <url> with the page's address before running it. Fetches the page and adds it to the library."
					/>
					<p className="fine-print">Asking the wiki is not offered here until it has a cost guard.</p>
				</Card>
				<Card title="Reading queue">
					<WithTile tile={today.data?.tiles.readings}>
						{(readings) => (
							<div className="stats stats-inline">
								<Stat value={readings.available} label="in queue" />
								<Stat value={readings.delivered} label="sent in a brief" />
							</div>
						)}
					</WithTile>
					<p className="fine-print">
						The reading ledger records delivery only, so readings are counted as in queue or sent in a brief.
					</p>
				</Card>
				<Card title="Last research run">
					{research === undefined ? (
						<p className="muted">No job data</p>
					) : (
						<>
							<StatusDot tone={JOB_TONE[research.health]} label={research.healthReason} />
							<p className="text-2">
								Last activity{" "}
								{research.lastActivity === null ? "unknown" : relativeTime(research.lastActivity.at, now)}
								<span className="muted"> (log mtime)</span>. Runs {research.schedule ?? "on schedule"}.
							</p>
						</>
					)}
				</Card>
			</div>
		</div>
	);
};
