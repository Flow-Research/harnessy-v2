/**
 * A small Markdown parser that returns a tree, never HTML.
 *
 * It covers what briefs and drafts use: headings, paragraphs, bullet and
 * numbered lists (with one nested level), block quotes, fenced code, rules and
 * pipe tables; inline strong, emphasis, code and links. Raw HTML is not
 * interpreted: it stays text. A link keeps its target as data; the renderer
 * decides with `safeHref` whether it becomes a link or stays text.
 *
 * The tree is bounded so that a hostile file cannot make the page build an
 * unbounded number of elements.
 */

export type Inline =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "strong"; readonly children: ReadonlyArray<Inline> }
	| { readonly type: "em"; readonly children: ReadonlyArray<Inline> }
	| { readonly type: "code"; readonly text: string }
	| { readonly type: "link"; readonly href: string; readonly children: ReadonlyArray<Inline> };

export interface ListItem {
	readonly children: ReadonlyArray<Inline>;
	readonly checked: boolean | null;
	readonly sublist: ListBlock | null;
}

export interface ListBlock {
	readonly type: "list";
	readonly ordered: boolean;
	readonly items: ReadonlyArray<ListItem>;
}

export type Block =
	| { readonly type: "heading"; readonly level: number; readonly children: ReadonlyArray<Inline> }
	| { readonly type: "paragraph"; readonly children: ReadonlyArray<Inline> }
	| ListBlock
	| { readonly type: "quote"; readonly children: ReadonlyArray<Block> }
	| { readonly type: "code"; readonly text: string }
	| { readonly type: "rule" }
	| {
			readonly type: "table";
			readonly header: ReadonlyArray<ReadonlyArray<Inline>>;
			readonly rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<Inline>>>;
	  };

/** Blocks parsed at most; the rest of the text is dropped with a note. */
export const MAX_BLOCKS = 2_000;
const MAX_INLINE_DEPTH = 6;

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/u;
const BULLET = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/u;
const FENCE = /^\s*(```|~~~)/u;
const RULE = /^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/u;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u;

/** Parse inline Markdown. Anything unmatched is text. */
export const parseInline = (source: string, depth = 0): ReadonlyArray<Inline> => {
	if (depth > MAX_INLINE_DEPTH) return [{ type: "text", text: source }];
	const out: Inline[] = [];
	let text = "";
	const flush = () => {
		if (text !== "") out.push({ type: "text", text });
		text = "";
	};
	let index = 0;
	while (index < source.length) {
		const rest = source.slice(index);
		const code = /^`([^`]+)`/u.exec(rest);
		if (code !== null) {
			flush();
			out.push({ type: "code", text: code[1]! });
			index += code[0].length;
			continue;
		}
		const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/u.exec(rest);
		if (strong !== null) {
			flush();
			out.push({ type: "strong", children: parseInline(strong[2]!, depth + 1) });
			index += strong[0].length;
			continue;
		}
		const em = /^([*_])(?=\S)([\s\S]*?\S)\1(?![*_])/u.exec(rest);
		if (em !== null && (index === 0 || /[\s(["']/u.test(source[index - 1]!))) {
			flush();
			out.push({ type: "em", children: parseInline(em[2]!, depth + 1) });
			index += em[0].length;
			continue;
		}
		const link = /^\[([^\]]{1,500})\]\(([^()\s]{1,500})\)/u.exec(rest);
		if (link !== null) {
			flush();
			out.push({ type: "link", href: link[2]!, children: parseInline(link[1]!, depth + 1) });
			index += link[0].length;
			continue;
		}
		text += source[index];
		index += 1;
	}
	flush();
	return out;
};

const cells = (line: string): ReadonlyArray<string> =>
	line
		.trim()
		.replace(/^\|/u, "")
		.replace(/\|$/u, "")
		.split("|")
		.map((cell) => cell.trim());

const checkbox = (text: string): { readonly checked: boolean | null; readonly text: string } => {
	const match = /^\[([ xX])\]\s+(.*)$/u.exec(text);
	return match === null ? { checked: null, text } : { checked: match[1] !== " ", text: match[2]! };
};

/** Parse a whole document into blocks. */
export const parseMarkdown = (source: string): ReadonlyArray<Block> => {
	const lines = source.replace(/\r\n?/gu, "\n").split("\n");
	const blocks: Block[] = [];
	let index = 0;
	const push = (block: Block) => {
		if (blocks.length < MAX_BLOCKS) blocks.push(block);
	};
	while (index < lines.length && blocks.length < MAX_BLOCKS) {
		const line = lines[index]!;
		if (line.trim() === "") {
			index += 1;
			continue;
		}
		if (FENCE.test(line)) {
			const fence = FENCE.exec(line)![1]!;
			const body: string[] = [];
			index += 1;
			while (index < lines.length && !lines[index]!.trim().startsWith(fence)) body.push(lines[index++]!);
			index += 1;
			push({ type: "code", text: body.join("\n") });
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading !== null) {
			push({ type: "heading", level: heading[1]!.length, children: parseInline(heading[2]!) });
			index += 1;
			continue;
		}
		if (RULE.test(line)) {
			push({ type: "rule" });
			index += 1;
			continue;
		}
		if (line.trim().startsWith("|") && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]!)) {
			const header = cells(line).map((cell) => parseInline(cell));
			const rows: Array<ReadonlyArray<ReadonlyArray<Inline>>> = [];
			index += 2;
			while (index < lines.length && lines[index]!.trim().startsWith("|") && rows.length < 500)
				rows.push(cells(lines[index++]!).map((cell) => parseInline(cell)));
			push({ type: "table", header, rows });
			continue;
		}
		if (line.trimStart().startsWith(">")) {
			const body: string[] = [];
			while (index < lines.length && lines[index]!.trimStart().startsWith(">"))
				body.push(lines[index++]!.trimStart().replace(/^>\s?/u, ""));
			push({ type: "quote", children: parseMarkdown(body.join("\n")).slice(0, 200) });
			continue;
		}
		const bullet = BULLET.exec(line);
		if (bullet !== null && bullet[1]!.length < 2) {
			const ordered = /\d/u.test(bullet[2]!);
			const items: ListItem[] = [];
			while (index < lines.length) {
				const current = BULLET.exec(lines[index]!);
				if (current === null || current[1]!.length >= 2) break;
				const first = checkbox(current[3]!);
				let text = first.text;
				const nested: ListItem[] = [];
				index += 1;
				// Continuation lines and one nested list level belong to this item.
				while (index < lines.length && lines[index]!.trim() !== "" && /^\s{2,}/u.test(lines[index]!)) {
					const child = BULLET.exec(lines[index]!);
					if (child !== null) {
						const box = checkbox(child[3]!);
						nested.push({ children: parseInline(box.text), checked: box.checked, sublist: null });
					} else if (nested.length > 0) {
						const last = nested.pop()!;
						nested.push({
							...last,
							children: [...last.children, { type: "text", text: ` ${lines[index]!.trim()}` }],
						});
					} else text += ` ${lines[index]!.trim()}`;
					index += 1;
				}
				items.push({
					children: parseInline(text),
					checked: first.checked,
					sublist: nested.length === 0 ? null : { type: "list", ordered: false, items: nested },
				});
				// A blank line between items of the same kind of list does not end the list.
				const next = BULLET.exec(lines[index + 1] ?? "");
				if (
					index < lines.length &&
					lines[index]!.trim() === "" &&
					next !== null &&
					next[1]!.length < 2 &&
					/\d/u.test(next[2]!) === ordered
				)
					index += 1;
			}
			push({ type: "list", ordered, items });
			continue;
		}
		const paragraph: string[] = [];
		while (
			index < lines.length &&
			lines[index]!.trim() !== "" &&
			!HEADING.test(lines[index]!) &&
			!FENCE.test(lines[index]!) &&
			!(BULLET.exec(lines[index]!)?.[1]?.length === 0) &&
			!lines[index]!.trimStart().startsWith(">")
		)
			paragraph.push(lines[index++]!.trim());
		// Every branch above consumes its line; this keeps the loop finite whatever the input.
		if (paragraph.length === 0) paragraph.push(lines[index++]!.trim());
		push({ type: "paragraph", children: parseInline(paragraph.join(" ")) });
	}
	return blocks;
};

/** Split blocks into sections at each level-2 heading. Blocks before the first one form an untitled section. */
export const sectionsOf = (
	blocks: ReadonlyArray<Block>,
): ReadonlyArray<{ readonly title: string | null; readonly blocks: ReadonlyArray<Block> }> => {
	const sections: Array<{ title: string | null; blocks: Block[] }> = [{ title: null, blocks: [] }];
	for (const block of blocks) {
		if (block.type === "heading" && block.level === 2)
			sections.push({ title: inlineText(block.children), blocks: [] });
		else sections[sections.length - 1]!.blocks.push(block);
	}
	return sections.filter((section) => section.title !== null || section.blocks.length > 0);
};

/** The plain text of inline nodes. */
export const inlineText = (nodes: ReadonlyArray<Inline>): string =>
	nodes.map((node) => (node.type === "text" || node.type === "code" ? node.text : inlineText(node.children))).join("");
