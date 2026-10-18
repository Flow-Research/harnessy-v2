/**
 * Connections, with Tools & integrations. Every action is a hand-off to the
 * owner of the credential: the app never runs OAuth and never holds, reads or
 * relays the Executor token.
 */
import { useEffect, useRef } from "react";

import { CommandChip, HandoffButton } from "../components/actions.tsx";
import { Card, StatusDot, type Tone, WithTile } from "../components/primitives.tsx";
import { ScreenHeader } from "../components/Shell.tsx";
import type { Connection, ConnectionsResponse, JobsResponse } from "../lib/api-types.ts";
import { useResource } from "../lib/data.tsx";

const STATUS: Readonly<Record<Connection["status"], { readonly tone: Tone; readonly label: string }>> = {
	connected: { tone: "ok", label: "connected" },
	attention: { tone: "danger", label: "needs attention" },
	not_configured: { tone: "idle", label: "not set up" },
	not_tracked: { tone: "idle", label: "not tracked here" },
	unknown: { tone: "idle", label: "unknown" },
};

const GROUPS = [
	{ title: "Accounts", keys: ["googleWorkspace", "codex"] },
	{ title: "Providers", keys: ["meeting", "community", "fathom"] },
] as const;

const ConnectionCard = ({ connection }: { connection: Connection }) => (
	<Card
		title={connection.label}
		actions={<StatusDot tone={STATUS[connection.status].tone} label={STATUS[connection.status].label} />}
	>
		<p className="text-2">
			Owned by {connection.owner}
			{connection.detail === null ? "" : ` · ${connection.detail}`}
		</p>
		{connection.action === null ? null : connection.action.kind === "link" ? (
			<HandoffButton
				action={{
					kind: "handoff",
					label: "Open the owner",
					target: connection.action.value,
					note: connection.action.note,
				}}
			/>
		) : (
			<CommandChip command={connection.action.value} note={connection.action.note} />
		)}
		{connection.action?.kind === "link" && connection.action.note !== null ? (
			<p className="fine-print">{connection.action.note}</p>
		) : null}
	</Card>
);

export const ConnectionsScreen = ({ rest }: { rest: ReadonlyArray<string> }) => {
	// `#/connections/tools` (the rail's "Tools & integrations") scrolls to and focuses that section.
	const tools = useRef<HTMLElement>(null);
	const toTools = rest[0] === "tools";
	useEffect(() => {
		if (!toTools || tools.current === null) return;
		tools.current.scrollIntoView?.({ block: "start" });
		tools.current.focus();
	}, [toTools]);
	const connections = useResource<ConnectionsResponse>("/v1/connections");
	const jobs = useResource<JobsResponse>("/v1/jobs");
	const executor =
		jobs.data?.tiles.jobs.state === "ok"
			? jobs.data.tiles.jobs.data?.jobs.find((job) => job.id === "executor")
			: undefined;
	const live = executor?.liveness.find((probe) => probe.open);
	const tiles = connections.data?.tiles;
	return (
		<div className="screen">
			<ScreenHeader title="Connections">
				<p className="text-2">Harnessy never signs in for you. Each card names the owner and how to reconnect.</p>
			</ScreenHeader>
			{GROUPS.map((group) => (
				<section key={group.title} className="section">
					<h2 className="section-title">{group.title}</h2>
					<div className="grid">
						{group.keys.map((key) => (
							<WithTile key={key} tile={tiles?.[key]}>
								{(list) => (
									<>
										{list.connections.map((connection) => (
											<ConnectionCard key={connection.id} connection={connection} />
										))}
										{list.omitted > 0 ? <p className="fine-print">{list.omitted} more not shown.</p> : null}
									</>
								)}
							</WithTile>
						))}
					</div>
				</section>
			))}
			<section className="section" id="tools" ref={tools} tabIndex={-1} aria-label="Tools & integrations">
				<h2 className="section-title">Tools &amp; integrations</h2>
				<Card
					title="The cockpit (Tools engine)"
					actions={
						<StatusDot
							tone={live === undefined ? "idle" : "ok"}
							label={
								live === undefined
									? "not running"
									: `running on ${live.host === "::1" ? "[::1]" : live.host}:4788`
							}
						/>
					}
				>
					<p className="text-2">
						Integrations and OAuth, secrets, policies, toolkits and agent tool-call approvals live in the cockpit.
						Those approvals are for agent tools, not for publishing meetings or briefings.
					</p>
					<CommandChip
						command="harnessy web"
						note="Starts the cockpit if needed and opens it with its own sign-in."
					/>
					{live === undefined ? null : (
						<HandoffButton
							action={{
								kind: "handoff",
								label: "Open cockpit",
								target: "http://localhost:4788/",
								note: "Sign-in code needed: run harnessy web.",
							}}
						/>
					)}
					<p className="fine-print">Harnessy never holds, reads or relays the cockpit's token.</p>
				</Card>
			</section>
		</div>
	);
};
