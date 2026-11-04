/**
 * The ⌘K command palette: search screens, inbox items, jobs and tasks, and copy
 * their commands. Enter runs the primary action (go there, or copy); Shift+Enter
 * copies. Phase A has no ▶ run actions.
 */
import { X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import { copyText, followHandoff } from "../lib/browser.ts";
import { hasFormatControls, visibleText, visibleTitle } from "../lib/format.ts";
import { trapTab } from "../lib/keys.tsx";
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
	const dialog = useRef<HTMLDivElement>(null);
	const results = useMemo(() => filterEntries(entries, query), [entries, query]);
	// Focus the search on open; give the focus back to whatever opened the palette on close.
	useEffect(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		input.current?.focus();
		return () => {
			if (opener?.isConnected === true && opener !== document.body) opener.focus();
		};
	}, []);

	const run = (entry: PaletteEntry | undefined, copyOnly: boolean) => {
		if (entry === undefined) return;
		if (entry.command !== undefined && (copyOnly || entry.target === undefined)) {
			// What is shown must be what is copied: a command with hidden characters is never copied.
			if (hasFormatControls(entry.command)) {
				setNotice(`Not copied: it holds hidden characters: ${visibleText(entry.command)}`);
				return;
			}
			void copyText(entry.command).then((ok) =>
				setNotice(ok ? `Copied: ${visibleText(entry.command!)}` : "The browser refused to copy."),
			);
			return;
		}
		if (entry.target !== undefined && followHandoff(entry.target)) onClose();
	};

	// Escape closes from anywhere in the dialog; Tab stays inside it while it is open.
	const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
		} else trapTab(event, dialog.current);
	};

	const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown") {
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

	const optionId = (index: number) => `palette-option-${index}`;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a backdrop click is a mouse shortcut; Escape and the close button are the keyboard paths
		<div
			className="palette-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				ref={dialog}
				className="palette"
				role="dialog"
				aria-modal="true"
				aria-label="Command palette"
				onKeyDown={onDialogKeyDown}
			>
				<div className="palette-input-row">
					<input
						ref={input}
						className="palette-input"
						type="search"
						role="combobox"
						aria-expanded="true"
						aria-controls="palette-results"
						aria-autocomplete="list"
						aria-activedescendant={results.length === 0 ? undefined : optionId(active)}
						placeholder="Search screens, jobs, tasks and commands"
						aria-label="Search"
						value={query}
						onKeyDown={onInputKeyDown}
						onChange={(event) => {
							setQuery(event.target.value);
							setActive(0);
						}}
					/>
					<button type="button" className="icon-button" onClick={onClose} aria-label="Close">
						<X size={16} strokeWidth={1.5} />
					</button>
				</div>
				{results.length === 0 ? <p className="palette-empty">Nothing matches.</p> : null}
				<div className="palette-results" id="palette-results" role="listbox" aria-label="Results">
					{results.map((entry, index) => (
						<div
							key={entry.id}
							id={optionId(index)}
							role="option"
							tabIndex={-1}
							aria-selected={index === active}
							className={index === active ? "palette-item palette-active" : "palette-item"}
							onMouseEnter={() => setActive(index)}
							onClick={(event) => run(entry, event.shiftKey)}
							onKeyDown={(event) => {
								if (event.key === "Enter") run(entry, event.shiftKey);
							}}
						>
							<span className="palette-group">{entry.group}</span>
							<span className="palette-title">{visibleTitle(entry.title)}</span>
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
									{visibleText(entry.command)}
								</code>
							)}
						</div>
					))}
				</div>
				<p className="palette-help" aria-live="polite">
					{notice === "" ? "Enter: go or copy · Shift+Enter: copy · Esc: close" : notice}
				</p>
			</div>
		</div>
	);
};
