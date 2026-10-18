/**
 * Phase A actions. Every action is either a hand-off (↗: open the owning
 * service or an in-app screen) or a command to copy (⧉). Nothing runs from here.
 */
import { Check, Copy, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import type { AppAction } from "../lib/api-types.ts";
import { copyText, followHandoff } from "../lib/browser.ts";
import { hasFormatControls, visibleText } from "../lib/format.ts";
import { safeAppRoute, safeHref } from "../lib/safe-href.ts";

export const HANDOFF_GLYPH = "↗";
export const COPY_GLYPH = "⧉";

/**
 * A command in mono with a copy button that confirms with "Copied". A command
 * that holds invisible format controls (bidi overrides, zero-width characters)
 * is shown with each control escaped and is never copied: what is shown would
 * not be what lands on the clipboard.
 */
export const CommandChip = ({ command, note }: { command: string; note?: string | null }) => {
	const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
	useEffect(() => {
		if (copied === "idle") return undefined;
		const timer = setTimeout(() => setCopied("idle"), 1_600);
		return () => clearTimeout(timer);
	}, [copied]);
	const shown = visibleText(command);
	const hidden = hasFormatControls(command);
	return (
		<div className="command">
			<div className="command-row">
				<span className="glyph" aria-hidden="true">
					{COPY_GLYPH}
				</span>
				<code className="command-text">{shown}</code>
				{hidden ? null : (
					<button
						type="button"
						className="icon-button"
						aria-label={`Copy command: ${shown}`}
						onClick={() => void copyText(command).then((ok) => setCopied(ok ? "copied" : "failed"))}
					>
						{copied === "copied" ? <Check size={16} strokeWidth={1.5} /> : <Copy size={16} strokeWidth={1.5} />}
						<span className="icon-button-text">
							{copied === "copied" ? "Copied" : copied === "failed" ? "Select and copy" : "Copy"}
						</span>
					</button>
				)}
			</div>
			{hidden ? (
				<p className="command-note tone-danger">Not copied: it holds hidden characters, shown as ⟨U+…⟩.</p>
			) : null}
			{note === undefined || note === null ? null : <p className="command-note">{note}</p>}
		</div>
	);
};

/** A hand-off button. Only a loopback URL or an in-app route is followed; anything else is shown as text. */
export const HandoffButton = ({ action, primary = false }: { action: AppAction; primary?: boolean }) => {
	const route = safeAppRoute(action.target);
	const href = safeHref(action.target);
	if (route === undefined && href === undefined) return <span className="mono muted">{action.target}</span>;
	return (
		<button
			type="button"
			className={primary ? "button button-primary" : "button"}
			onClick={() => followHandoff(action.target)}
			title={action.note ?? undefined}
		>
			{action.label}
			{route === undefined ? (
				<>
					{" "}
					<ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" />
					<span className="sr-only"> (opens a new tab)</span>
				</>
			) : null}
		</button>
	);
};

/** Every action of an item: hand-offs as buttons, copies as command chips. */
export const ActionList = ({ actions }: { actions: ReadonlyArray<AppAction> }) => {
	const handoffs = actions.filter((action) => action.kind === "handoff");
	const copies = actions.filter((action) => action.kind === "copy");
	return (
		<div className="actions">
			{handoffs.length === 0 ? null : (
				<div className="button-row">
					{handoffs.map((action, index) => (
						<HandoffButton key={`${action.label}-${action.target}`} action={action} primary={index === 0} />
					))}
				</div>
			)}
			{copies.map((action) => (
				<div key={`${action.label}-${action.target}`} className="action-copy">
					<p className="label">{action.label}</p>
					<CommandChip command={action.target} note={action.note} />
				</div>
			))}
		</div>
	);
};
