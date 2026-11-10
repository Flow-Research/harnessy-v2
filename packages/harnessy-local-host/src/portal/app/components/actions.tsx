/**
 * Actions open an owning service or in-app screen (↗), or show a command to
 * copy (⧉). Fixed service destinations use authenticated local browser launchers.
 */
import { Check, Copy, ExternalLink } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import { handoffService, type PortalHandoffService } from "../../handoff.ts";

import type { AppAction } from "../lib/api-types.ts";
import { copyText, followHandoff } from "../lib/browser.ts";
import { hasFormatControls, visibleText } from "../lib/format.ts";
import { safeAppRoute, safeHref, safeReviewHandoffHref } from "../lib/safe-href.ts";
import type { ApiResult } from "../lib/session.ts";

const HandoffContext = createContext<(service: PortalHandoffService) => Promise<ApiResult>>(async () => ({
	kind: "signed_out",
}));

export const HandoffProvider = ({
	open,
	children,
}: {
	readonly open: (service: PortalHandoffService) => Promise<ApiResult>;
	readonly children: ReactNode;
}) => <HandoffContext.Provider value={open}>{children}</HandoffContext.Provider>;

/** Buttons and Inbox keyboard shortcuts use the same authenticated launcher. */
export const useHandoff = () => {
	const open = useContext(HandoffContext);
	const [notice, setNotice] = useState("");
	const [opening, setOpening] = useState(false);
	useEffect(() => {
		const returned = () => {
			setOpening(false);
			setNotice("");
		};
		window.addEventListener("pageshow", returned);
		return () => window.removeEventListener("pageshow", returned);
	}, []);
	const follow = async (target: string) => {
		const service = handoffService(target);
		if (service === undefined) return void followHandoff(target);
		if (opening) return;
		setOpening(true);
		setNotice("Opening view…");
		let navigating = false;
		try {
			const result = await open(service);
			if (
				result.kind === "ok" &&
				typeof result.body === "object" &&
				result.body !== null &&
				"url" in result.body &&
				typeof result.body.url === "string"
			) {
				const href = safeReviewHandoffHref(result.body.url);
				if (href === undefined) throw new Error("invalid_service_destination");
				window.location.assign(href);
				navigating = true;
				return;
			}
			setNotice(
				result.kind === "ok"
					? "Opened view."
					: result.kind === "signed_out"
						? "Your Harnessy session ended. Run harnessy open, then try again."
						: result.message,
			);
		} catch {
			setNotice("The view could not open. Check its service on the Jobs screen, then try again.");
		} finally {
			if (!navigating) setOpening(false);
		}
	};
	return { follow, notice, opening };
};

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
	const { follow, notice, opening } = useHandoff();
	const service = handoffService(action.target);
	const route = safeAppRoute(action.target);
	const href = safeHref(action.target);
	if (route === undefined && href === undefined && service === undefined)
		return <span className="mono muted">{visibleText(action.target)}</span>;
	return (
		<>
			<button
				type="button"
				className={primary ? "button button-primary" : "button"}
				onClick={() => void follow(action.target)}
				disabled={opening}
				aria-busy={opening}
				title={action.note ?? undefined}
			>
				{action.label}
				{route === undefined ? (
					<>
						{" "}
						<ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" />
						<span className="sr-only">
							{service === undefined
								? " (opens a new tab)"
								: service === "cockpit"
									? " (opens in your browser)"
									: " (opens in this tab)"}
						</span>
					</>
				) : null}
			</button>
			{notice === "" ? null : <output className="fine-print">{notice}</output>}
		</>
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
