/**
 * Renders the Markdown tree as React elements. Text is escaped by React; a link
 * becomes an anchor only when `safeHref` accepts it and is shown as text with
 * its target otherwise. There is no path from source text to markup.
 */
import { type Block, type Inline, type ListBlock, parseMarkdown } from "../lib/markdown.ts";
import { safeHref } from "../lib/safe-href.ts";
import { ErrorBoundary, PlainTextFallback } from "./ErrorBoundary.tsx";

/** Pair each item with a key. A parsed document never reorders, so position is each item's identity. */
const withKeys = <T,>(items: ReadonlyArray<T>, prefix: string) =>
	items.map((value, position) => ({ value, key: `${prefix}-${position}` }));

const InlineNodes = ({ nodes }: { nodes: ReadonlyArray<Inline> }) => (
	<>
		{nodes.map((node, index) => {
			// A parsed document never reorders: position is each node's identity.
			const key = `${node.type}-${index}`;
			switch (node.type) {
				case "text":
					return <span key={key}>{node.text}</span>;
				case "code":
					return (
						<code key={key} className="inline-code">
							{node.text}
						</code>
					);
				case "strong":
					return (
						<strong key={key}>
							<InlineNodes nodes={node.children} />
						</strong>
					);
				case "em":
					return (
						<em key={key}>
							<InlineNodes nodes={node.children} />
						</em>
					);
				case "link": {
					const href = safeHref(node.href);
					return href === undefined ? (
						<span key={key} className="link-text">
							<InlineNodes nodes={node.children} /> <span className="muted">({node.href})</span>
						</span>
					) : (
						<a key={key} href={href} target="_blank" rel="noreferrer noopener">
							<InlineNodes nodes={node.children} />
						</a>
					);
				}
				default:
					return null;
			}
		})}
	</>
);

const List = ({ list }: { list: ListBlock }) => {
	const items = withKeys(list.items, "item").map(({ value: item, key }) => (
		<li key={key} className={item.checked === null ? undefined : item.checked ? "task-done" : "task-open"}>
			{item.checked === null ? null : (
				<span className="checkbox">
					<span aria-hidden="true">{item.checked ? "☑" : "☐"}</span>
					<span className="sr-only">{item.checked ? "done: " : "open: "}</span>
				</span>
			)}
			<InlineNodes nodes={item.children} />
			{item.sublist === null ? null : <List list={item.sublist} />}
		</li>
	));
	return list.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
};

export const MarkdownBlocks = ({ blocks }: { blocks: ReadonlyArray<Block> }) => (
	<>
		{blocks.map((block, index) => {
			const key = `${block.type}-${index}`;
			switch (block.type) {
				case "heading": {
					const level = Math.min(6, block.level + 1);
					const Heading = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
					return (
						<Heading key={key} className="md-heading">
							<InlineNodes nodes={block.children} />
						</Heading>
					);
				}
				case "paragraph":
					return (
						<p key={key}>
							<InlineNodes nodes={block.children} />
						</p>
					);
				case "list":
					return <List key={key} list={block} />;
				case "quote":
					return (
						<blockquote key={key}>
							<MarkdownBlocks blocks={block.children} />
						</blockquote>
					);
				case "code":
					return (
						<pre key={key} className="code-block">
							<code>{block.text}</code>
						</pre>
					);
				case "rule":
					return <hr key={key} />;
				case "table":
					return (
						<div key={key} className="table-scroll">
							<table className="md-table">
								<thead>
									<tr>
										{withKeys(block.header, "h").map(({ value: cell, key: cellKey }) => (
											<th key={cellKey}>
												<InlineNodes nodes={cell} />
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{withKeys(block.rows, "r").map(({ value: row, key: rowKey }) => (
										<tr key={rowKey}>
											{withKeys(row, "c").map(({ value: cell, key: cellKey }) => (
												<td key={cellKey}>
													<InlineNodes nodes={cell} />
												</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					);
				default:
					return null;
			}
		})}
	</>
);

const ParsedMarkdown = ({ text }: { text: string }) => (
	<div className="markdown">
		<MarkdownBlocks blocks={parseMarkdown(text)} />
	</div>
);

/** Markdown as React elements. If parsing or rendering ever fails, the text is shown as written instead. */
export const SafeMarkdown = ({ text }: { text: string }) => (
	<ErrorBoundary fallback={<PlainTextFallback text={text} />} resetKey={text}>
		<ParsedMarkdown text={text} />
	</ErrorBoundary>
);
