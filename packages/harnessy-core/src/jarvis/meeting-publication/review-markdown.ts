import { Marked } from "marked";

const escapeHtml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

export const redactMeetingPublicationReviewText = (value: string) =>
	value
		.replace(/\b(?:javascript|data):[^\s<>"']*/giu, "[unsafe link removed]")
		.replace(/\b(?:api[-_ ]?key|token|secret|password|credential)\b\s*[:=]\s*[^\s]+/giu, "[credential removed]");

const reviewMarkdown = new Marked({
	async: false,
	gfm: false,
	renderer: {
		html({ text }) {
			return escapeHtml(text);
		},
		link({ href, title, tokens }) {
			const label = this.parser.parseInline(tokens);
			const destination = URL.parse(href);
			if (destination === null || (destination.protocol !== "http:" && destination.protocol !== "https:")) {
				return label;
			}
			const titleAttribute = title === null || title === undefined ? "" : ` title="${escapeHtml(title)}"`;
			return `<a href="${escapeHtml(destination.href)}"${titleAttribute} rel="noreferrer">${label}</a>`;
		},
		image({ text }) {
			return escapeHtml(text.length === 0 ? "[Image]" : `[Image: ${text}]`);
		},
	},
});

export const renderMeetingPublicationReviewMarkdown = (value: string): string =>
	reviewMarkdown.parse(redactMeetingPublicationReviewText(value), { async: false });

/** Present V1's collapsible metadata without changing the canonical editor input. */
export const renderMeetingPublicationReviewNote = (value: string): string => {
	const tokens = reviewMarkdown.lexer(redactMeetingPublicationReviewText(value));
	const metadata = reviewMarkdown.lexer("");
	const body = reviewMarkdown.lexer("");
	let firstContent = true;
	let inMetadata = false;
	for (const token of tokens) {
		if (firstContent && token.type !== "space") {
			firstContent = false;
			if (token.type === "heading" && token.depth === 1) continue;
		}
		if (token.type === "heading" && token.depth <= 2) {
			inMetadata = token.depth === 2 && token.text.trim().toLowerCase() === "metadata";
			if (inMetadata) continue;
		}
		(inMetadata ? metadata : body).push(token);
	}
	const renderedMetadata = reviewMarkdown.parser(metadata).trim();
	return (
		(renderedMetadata.length === 0
			? ""
			: `<details class="metadata-card"><summary>Meeting metadata</summary><div class="markdown-body metadata-body">${renderedMetadata}</div></details>`) +
		reviewMarkdown.parser(body)
	);
};
