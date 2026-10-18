/**
 * The ⌘K command palette: search screens, inbox items, jobs and tasks, and copy
 * their commands. Enter runs the primary action (go there, or copy); Shift+Enter
 * copies. Phase A has no ▶ run actions.
 */
import { X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import { copyText, followHandoff } from "../lib/browser.ts";
import { routeHref, SCREEN_TITLES, SCREENS } from "../lib/router.ts";
import { COPY_GLYPH, HANDOFF_GLYPH } from "./actions.tsx";

export interface PaletteEntry {
	readonly id: string;
	readonly title: string;
	readonly group: "Screens" | "Inbox" | "Jobs" | "Tasks" | "Commands";
	/** In-app route or loopback URL to follow. */
	readonly target?: string;
	/** Command to copy. */
	readonly command?: string;
}

export const screenEntries = (): ReadonlyArray<PaletteEntry> =>
	SCREENS.map((screen) => ({
		id: `screen:${screen}`,
		title: SCREEN_TITLES[screen],
		group: "Screens",
		target: routeHref(screen),
	}));

const MAX_RESULTS = 50;

/** Entries whose title or command contains every word of `query`, in order of the list. */
export const filterEntries = (entries: ReadonlyArray<PaletteEntry>, query: string): ReadonlyArray<PaletteEntry> => {
	const words = query
		.toLowerCase()
		.split(/\s+/u)
		.filter((word) => word.length > 0);
	return entries
		.filter((entry) => {
			const haystack = `${entry.group} ${entry.title} ${entry.command ?? ""}`.toLowerCase();
			return words.every((word) => haystack.includes(word));
		})
		.slice(0, MAX_RESULTS);
};

export const Palette = ({ entries, onClose }: { entries: ReadonlyArray<PaletteEntry>; onClose: () => void }) => {
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const [notice, setNotice] = useState("");
	const input = useRef<HTMLInputElement>(null);
	const results = useMemo(() => filterEntries(entries, query), [entries, query]);
	useEffect(() => input.current?.focus(), []);

	const run = (entry: PaletteEntry | undefined, copyOnly: boolean) => {
		if (entry === undefined) return;
		if (entry.command !== undefined && (copyOnly || entry.target === undefined)) {
			void copyText(entry.command).then((ok) =>
				setNotice(ok ? `Copied: ${entry.command}` : "The browser refused to copy."),
			);
			return;
		}
		if (entry.target !== undefined && followHandoff(entry.target)) onClose();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			setActive((index) => Math.min(results.length - 1, index + 1));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActive((index) => Math.max(0, index - 1));
		} else if (event.key === "Enter") {
			event.preventDefault();
			run(results[active], event.shiftKey);
		}
	};

	return (
		<div className="palette-backdrop">
			<div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
				<div className="palette-input-row">
					<input
						ref={input}
						className="palette-input"
						type="search"
						placeholder="Search screens, jobs, tasks and commands"
						aria-label="Search"
						value={query}
						onKeyDown={onKeyDown}
						onChange={(event) => {
							setQuery(event.target.value);
							setActive(0);
						}}
					/>
					<button type="button" className="icon-button" onClick={onClose} aria-label="Close">
						<X size={16} strokeWidth={1.5} />
					</button>
				</div>
				<ul className="palette-results" aria-label="Results">
					{results.length === 0 ? <li className="palette-empty">Nothing matches.</li> : null}
					{results.map((entry, index) => (
						<li key={entry.id}>
							<button
								type="button"
								className={index === active ? "palette-item palette-active" : "palette-item"}
								aria-current={index === active ? "true" : undefined}
								onMouseEnter={() => setActive(index)}
								onClick={(event) => run(entry, event.shiftKey)}
							>
								<span className="palette-group">{entry.group}</span>
								<span className="palette-title">{entry.title}</span>
								{entry.command === undefined ? (
									<span className="glyph">
										{HANDOFF_GLYPH}
										<span className="sr-only"> go</span>
									</span>
								) : (
									<code className="palette-command">
										<span className="glyph" aria-hidden="true">
											{COPY_GLYPH}
										</span>{" "}
										{entry.command}
									</code>
								)}
							</button>
						</li>
					))}
				</ul>
				<p className="palette-help" aria-live="polite">
					{notice === "" ? "Enter: go or copy · Shift+Enter: copy · Esc: close" : notice}
				</p>
			</div>
		</div>
	);
};
