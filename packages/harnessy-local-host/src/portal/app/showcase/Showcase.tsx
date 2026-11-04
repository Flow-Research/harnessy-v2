/**
 * The shared controls in each state, with switches for theme, density and
 * direction. It renders the real classes and components the app uses, so a
 * change to a token or a control shows here first. Text includes long labels,
 * tone marks and right-to-left words on purpose.
 */
import { Plus, RefreshCw, TerminalSquare, Trash2 } from "lucide-react";
import { useState } from "react";

import { CommandChip } from "../components/actions.tsx";
import { Badge, Card, EmptyState, StatusDot } from "../components/primitives.tsx";

const LONG = "Separate Git worktree for Ìbàdàn Life community research and onboarding";

export const Showcase = () => {
	const [theme, setTheme] = useState<"dark" | "light">("dark");
	const [compact, setCompact] = useState(false);
	const [rtl, setRtl] = useState(false);
	const [pressed, setPressed] = useState(false);
	const apply = (next: { theme?: "dark" | "light"; compact?: boolean; rtl?: boolean }) => {
		const root = document.documentElement;
		if (next.theme !== undefined) {
			root.dataset.theme = next.theme;
			setTheme(next.theme);
		}
		if (next.compact !== undefined) {
			root.dataset.density = next.compact ? "compact" : "comfortable";
			setCompact(next.compact);
		}
		if (next.rtl !== undefined) {
			root.dir = next.rtl ? "rtl" : "ltr";
			setRtl(next.rtl);
		}
	};
	return (
		<main className="content showcase">
			<header className="screen-header">
				<h1 className="screen-title">Harnessy controls</h1>
				<p className="text-2">Development only. Every control here is the one the app uses.</p>
			</header>
			<fieldset className="button-row showcase-settings" aria-label="Preview settings">
				<button
					type="button"
					className="button button-sm"
					aria-pressed={theme === "light"}
					onClick={() => apply({ theme: theme === "dark" ? "light" : "dark" })}
				>
					Light theme
				</button>
				<button
					type="button"
					className="button button-sm"
					aria-pressed={compact}
					onClick={() => apply({ compact: !compact })}
				>
					Compact density
				</button>
				<button type="button" className="button button-sm" aria-pressed={rtl} onClick={() => apply({ rtl: !rtl })}>
					Right to left
				</button>
			</fieldset>

			<Card title="Buttons">
				<div className="button-row">
					<button type="button" className="button button-primary">
						<Plus aria-hidden="true" /> Start agent
					</button>
					<button type="button" className="button">
						Work on this
					</button>
					<button type="button" className="button button-quiet">
						Keep draft and close
					</button>
					<button type="button" className="button button-danger">
						<Trash2 aria-hidden="true" /> End session
					</button>
				</div>
				<div className="button-row">
					<button type="button" className="button button-primary" aria-busy="true" disabled>
						Starting…
					</button>
					<button type="button" className="button" disabled>
						Attach existing session
					</button>
					<button type="button" className="button" aria-pressed={pressed} onClick={() => setPressed(!pressed)}>
						Toggle ({pressed ? "on" : "off"})
					</button>
					<button type="button" className="button button-sm">
						Ctrl-C
					</button>
					<button type="button" className="icon-button" aria-label="Read again">
						<RefreshCw size={14} aria-hidden="true" />
					</button>
				</div>
				<p className="fine-print">
					Primary: one per region. Danger: only for ending work. Quiet: low-emphasis exits.
				</p>
			</Card>

			<Card title="Fields and selects">
				<div className="quick-actions-row">
					<label className="field">
						Task title
						<input className="input" defaultValue="Approve the Garden beta checklist" />
					</label>
					<label className="field">
						Working copy
						<span className="select">
							<select defaultValue="long">
								<option value="long">{LONG}</option>
								<option value="existing">Existing checkout</option>
							</select>
						</span>
						<span className="field-hint">A long label ends before the arrow.</span>
					</label>
				</div>
				<label className="field">
					Instructions
					<textarea
						className="textarea"
						defaultValue={"Draft the reply. مرحبا بالعالم stays isolated.\nYorùbá: ọ̀rọ̀, Ẹ̀kọ́."}
					/>
				</label>
				<p className="form-error" role="alert">
					Project is not trusted. Choose another project or trust this one first.
				</p>
			</Card>

			<Card title="Status and badges">
				<div className="button-row">
					<StatusDot tone="ok" label="running" />
					<StatusDot tone="attention" label="interrupted" />
					<StatusDot tone="danger" label="failed" />
					<StatusDot tone="idle" label="exited" />
					<span className="pill">not journaled</span>
					<Badge count={5} tone="danger" label="Needs you" />
				</div>
				<CommandChip
					command="harnessy jarvis meeting fathom poll --profile research --since 2026-10-01"
					note="Copies the command."
				/>
			</Card>

			<Card title="Menu items">
				<div className="quick-actions-menu">
					<button type="button" className="quick-actions-item">
						<Plus size={18} aria-hidden="true" />
						<span>Start agent task</span>
						<span className="quick-actions-item-hint">
							Choose an agent and a project, then describe the work.
						</span>
					</button>
					<button type="button" className="quick-actions-item">
						<TerminalSquare size={18} aria-hidden="true" />
						<span>Open terminals</span>
						<span className="quick-actions-item-hint">Closing this view leaves sessions running.</span>
					</button>
				</div>
			</Card>

			<article className="card article">
				<div className="markdown">
					<Card title="Decisions and Actions for You" className="brief-pinned">
						<p>
							<strong>Approve the beta checklist.</strong> Review{" "}
							<a href="https://example.test/checklist" target="_blank" rel="noopener noreferrer">
								the checklist
							</a>
							.
						</p>
						<button type="button" className="button button-sm brief-section-action">
							Work on this
						</button>
					</Card>
				</div>
			</article>

			<EmptyState title="Nothing waiting" tone="attention">
				<p>A recovery action sits beside the message it resolves.</p>
				<button type="button" className="button button-primary">
					<RefreshCw aria-hidden="true" /> Generate today’s brief
				</button>
			</EmptyState>
		</main>
	);
};
