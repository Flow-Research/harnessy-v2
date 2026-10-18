/**
 * The detail of a selected row. At 1100 px and wider it sits beside the list.
 * Narrower, it opens as a sheet over the list when a row is chosen: focus moves
 * into the sheet, Tab stays inside it, Escape, the close button or a click on
 * the backdrop close it, and focus returns to the row that opened it.
 */
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { trapTab } from "../lib/keys.tsx";

export const WIDE_LAYOUT_QUERY = "(min-width: 1100px)";

const wideNow = (): boolean =>
	typeof window.matchMedia === "function" ? window.matchMedia(WIDE_LAYOUT_QUERY).matches : true;

/** Whether the window is wide enough for the side-by-side detail; follows resizes. */
export const useWideLayout = (): boolean => {
	const [wide, setWide] = useState(wideNow);
	useEffect(() => {
		if (typeof window.matchMedia !== "function") return undefined;
		const query = window.matchMedia(WIDE_LAYOUT_QUERY);
		const onChange = () => setWide(query.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);
	return wide;
};

const DetailSheet = ({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) => {
	const sheet = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		sheet.current?.focus();
		return () => {
			if (opener?.isConnected === true) opener.focus();
		};
	}, []);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a backdrop click is a mouse shortcut; Escape and the close button are the keyboard paths
		<div
			className="sheet-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				ref={sheet}
				className="detail sheet"
				role="dialog"
				aria-modal="true"
				aria-label={label}
				tabIndex={-1}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onClose();
					} else trapTab(event, sheet.current);
				}}
			>
				<button type="button" className="icon-button sheet-close" onClick={onClose} aria-label="Close">
					<X size={16} strokeWidth={1.5} />
				</button>
				{children}
			</div>
		</div>
	);
};

export const DetailPane = ({
	label,
	open,
	onClose,
	children,
}: {
	label: string;
	/** A row was chosen explicitly (the route names it); only then does the narrow sheet open. */
	open: boolean;
	onClose: () => void;
	children: ReactNode;
}) => {
	const wide = useWideLayout();
	if (wide)
		return (
			<aside className="detail" aria-label={label}>
				{children}
			</aside>
		);
	return open ? (
		<DetailSheet label={label} onClose={onClose}>
			{children}
		</DetailSheet>
	) : null;
};
