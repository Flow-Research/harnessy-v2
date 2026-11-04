import { type Block, inlineText } from "../lib/markdown.ts";
import { safeExternalHref } from "../lib/safe-href.ts";
import { LinkedText, MarkdownBlocks } from "./SafeMarkdown.tsx";

/** Decode entity tokens only. Source HTML never enters the DOM. */
export const readingText = (text: string): string =>
	text.replace(
		/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);/giu,
		(entity) => new DOMParser().parseFromString(`x${entity}`, "text/html").body.textContent?.slice(1) ?? entity,
	);

export const readingHref = (source: string): string | undefined => {
	const value = readingText(source.startsWith("<") && source.endsWith(">") ? source.slice(1, -1) : source);
	return safeExternalHref(value);
};

export const WorthReading = ({ blocks }: { blocks: ReadonlyArray<Block> }) => (
	<div className="worth-reading">
		{blocks.map((block, blockIndex) => {
			const key = `reading-block-${blockIndex}`;
			if (block.type !== "list") return <MarkdownBlocks key={key} blocks={[block]} />;
			return (
				<ul key={key} className="reading-list">
					{block.items.map((item, index) => {
						const [title, ...description] = item.children;
						const itemKey = `reading-${index}`;
						if (title?.type !== "link")
							return (
								<li key={itemKey}>
									<LinkedText text={readingText(inlineText(item.children))} />
								</li>
							);
						const href = readingHref(title.href);
						const label = readingText(inlineText(title.children));
						const detail = readingText(inlineText(description))
							.replace(/^\s*[—–-]\s*/u, "")
							.trim();
						return (
							<li key={itemKey}>
								{href ? (
									<a className="reading-title" href={href} target="_blank" rel="noopener noreferrer">
										{label}
									</a>
								) : (
									<span className="reading-title">{label}</span>
								)}
								{detail ? (
									<p className="reading-description">
										<LinkedText text={detail} />
									</p>
								) : null}
							</li>
						);
					})}
				</ul>
			);
		})}
	</div>
);
