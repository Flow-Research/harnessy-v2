import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef } from "react";
import type { InboxItem } from "../lib/api-types.ts";
import { visibleTitle } from "../lib/format.ts";
import { ActionList } from "./actions.tsx";

export const InboxRowMenu = ({
	item,
	archived,
	busy,
	onAgent,
	onArchive,
}: {
	item: InboxItem;
	archived: boolean;
	busy: boolean;
	onAgent: () => void;
	onArchive: () => void;
}) => {
	const ref = useRef<HTMLDetailsElement>(null);
	useEffect(() => {
		const outside = (event: PointerEvent) => {
			if (event.target instanceof Node && !ref.current?.contains(event.target) && ref.current)
				ref.current.open = false;
		};
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, []);
	const close = () => {
		if (ref.current) {
			ref.current.open = false;
			ref.current.querySelector("summary")?.focus();
		}
	};
	return (
		<details
			className="inbox-row-menu"
			ref={ref}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					close();
				}
			}}
		>
			<summary aria-label={`Actions for ${visibleTitle(item.title)}`}>
				<MoreHorizontal size={18} aria-hidden="true" />
			</summary>
			<div className="inbox-menu-actions">
				<button
					type="button"
					className="button"
					onClick={() => {
						close();
						onAgent();
					}}
				>
					Ask an agent
				</button>
				<button
					type="button"
					className="button"
					disabled={busy}
					onClick={() => {
						close();
						onArchive();
					}}
				>
					{archived ? "Move to Inbox" : "Archive"}
				</button>
				<ActionList actions={item.actions} />
			</div>
		</details>
	);
};
