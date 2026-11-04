import { createContext, type ReactNode, useContext, useRef, useState } from "react";
import type { TodayResponse } from "../lib/api-types.ts";
import { useDataStore, useResource } from "../lib/data.tsx";
import type { ApiResult } from "../lib/session.ts";
import "./weekly-draft.css";
import { useBriefAction } from "./QuickActions.tsx";

const CloseContext = createContext<(run: string, reason: string) => Promise<ApiResult>>(async () => ({
	kind: "signed_out",
}));
export const WeeklyDraftProvider = ({
	close,
	children,
}: {
	close: (run: string, reason: string) => Promise<ApiResult>;
	children: ReactNode;
}) => <CloseContext.Provider value={close}>{children}</CloseContext.Provider>;

export const CloseWeeklyDraft = ({ runHash }: { runHash: string }) => {
	const workOn = useBriefAction();
	const evidence = useResource<{
		periodId: string;
		state: string;
		evidenceUnavailable: boolean;
		failure: { phase: string; errors: string[]; recordedAt: string | null; rawDraftPreserved: boolean } | null;
	}>(`/v1/life/weekly/${runHash}/status`);
	const close = useContext(CloseContext);
	const store = useDataStore();
	const today = useResource<TodayResponse>("/v1/today");
	const run = today.data?.tiles.weeklyRuns.data?.runs.find((candidate) => candidate.runHash === runHash);
	const failed = run?.state === "failed" || run?.state === "interrupted";
	const noun = failed || evidence.data?.failure ? "failed attempt" : "draft";
	const [editing, setEditing] = useState(false);
	const [reason, setReason] = useState("");
	const [notice, setNotice] = useState("");
	const [closed, setClosed] = useState(false);
	const [pending, setPending] = useState(false);
	const inFlight = useRef(false);
	const button = useRef<HTMLButtonElement>(null);
	const submit = async () => {
		if (inFlight.current || !reason.trim()) return;
		inFlight.current = true;
		setPending(true);
		setNotice("");
		try {
			const result = await close(runHash, reason.trim());
			if (result.kind === "ok") {
				await store.refreshAll();
				setClosed(true);
				setEditing(false);
			} else
				setNotice(
					result.kind === "signed_out"
						? "Your session ended. Sign in again before closing this draft."
						: result.message,
				);
		} catch {
			setNotice("The connection was interrupted. Refresh the status before trying again.");
		} finally {
			inFlight.current = false;
			setPending(false);
		}
	};
	return (
		<section className="weekly-review" aria-label="Weekly draft actions">
			<h2>
				{closed || (!pending && run?.state === "reconciled")
					? noun === "draft"
						? "Draft closed"
						: "Attempt closed"
					: "What would you like to do?"}
			</h2>
			{evidence.data?.failure ? (
				<div>
					<h3>What happened · {evidence.data.periodId}</h3>
					<p>
						{evidence.data.failure.errors.some((error) => error.includes("login"))
							? "The configured agent could not renew its sign-in. Check its connection before generating another plan."
							: `The attempt stopped during ${evidence.data.failure.phase}. Review the recorded error before taking action.`}
					</p>
					<p>
						{evidence.data.failure.rawDraftPreserved
							? "A partial draft was saved for inspection. It has not passed review."
							: "No partial draft was recorded."}
					</p>
					<details>
						<summary>Technical details</summary>
						<p>{evidence.data.failure.recordedAt}</p>
						<pre>{evidence.data.failure.errors.join("\n\n")}</pre>
					</details>
					<button
						type="button"
						className="button"
						onClick={() =>
							workOn({
								title: `Investigate weekly plan ${evidence.data!.periodId}`,
								source: `Weekly run ${runHash}`,
								text: `Investigate this weekly failure. Preserve its evidence. Check the configured agent's authentication and explain the repair. Do not publish, reconcile, reuse a consumed grant or generate a different week without explicit approval.\n\n${evidence.data!.failure!.errors.join("\n")}`,
							})
						}
					>
						Investigate with an agent
					</button>
					<p className="fine-print">
						Opens Actions with this failure attached. Choose the agent and working directory before launching it.
					</p>
				</div>
			) : failed ? (
				<p>
					{evidence.status === "loading"
						? "Loading the recorded failure…"
						: "The failure details could not be read. Open the weekly job to inspect its logs."}
				</p>
			) : null}
			{closed || (!pending && run?.state === "reconciled") ? (
				<output>
					This {noun} is closed. Saved documents and history are kept. Nothing was published or regenerated.
				</output>
			) : (
				<>
					<p>
						{failed
							? "You can investigate the cause or close this failed attempt with a reason. Closing preserves the evidence and clears this Inbox item."
							: "Read the plan below. If you no longer need it, close it with a reason."}
					</p>
					{failed ? (
						<p className="muted">
							Retry from this view is not available yet. A retry needs a new authorization for this exact week;
							the previous authorization cannot be reused. Closing does not start another run.
						</p>
					) : null}
					<p className="muted">
						This only holds another run for the same week. Other weeks, daily briefs and meeting publication can
						continue.
					</p>
					{editing ? (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void submit();
							}}
						>
							<label htmlFor="weekly-close-reason">Why are you closing this {noun}?</label>
							<textarea
								id="weekly-close-reason"
								ref={(element) => element?.focus()}
								required
								maxLength={200}
								value={reason}
								disabled={pending}
								onChange={(event) => setReason(event.target.value)}
								placeholder="For example: The week has passed; this plan is no longer needed."
							/>
							<p className="fine-print">
								Confirming marks this {noun} as {failed ? "abandoned" : "superseded"} and clears its Inbox item.
								This decision cannot be undone here. The saved evidence stays available; nothing is published or
								regenerated.
							</p>
							<div className="weekly-review-actions">
								<button className="button button-primary" type="submit" disabled={pending || !reason.trim()}>
									{pending ? "Closing…" : "Confirm close"}
								</button>
								<button
									className="button"
									type="button"
									disabled={pending}
									onClick={() => {
										setEditing(false);
										setNotice("");
										requestAnimationFrame(() => button.current?.focus());
									}}
								>
									Cancel
								</button>
							</div>
						</form>
					) : (
						<button
							ref={button}
							className="button"
							type="button"
							disabled={
								!run ||
								!["drafted", "failed", "interrupted"].includes(run.state) ||
								run.incompleteReconciliation
							}
							onClick={() => setEditing(true)}
						>
							Close {noun}
						</button>
					)}
					{run === undefined ? (
						<p className="muted">
							{today.status === "error"
								? "Could not check the draft status. Refresh to try again."
								: "Checking draft status…"}
						</p>
					) : null}
				</>
			)}
			{notice ? <p role="alert">{notice}</p> : null}
			<a className="back-link" href="#/inbox">
				Back to Inbox
			</a>
		</section>
	);
};
