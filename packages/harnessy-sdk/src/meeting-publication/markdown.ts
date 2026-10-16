interface TextSpan {
	readonly start: number;
	readonly end: number;
	readonly style: Readonly<Record<string, unknown>>;
	readonly fields: string;
}

interface ParagraphSpan {
	readonly start: number;
	readonly end: number;
	readonly kind: "heading" | "bullet" | "quote";
	readonly value: string;
}

export interface RenderedMeetingMarkdown {
	readonly text: string;
	readonly textSpans: ReadonlyArray<TextSpan>;
	readonly paragraphSpans: ReadonlyArray<ParagraphSpan>;
}

const utf16Length = (value: string): number => {
	let length = 0;
	for (const character of value) length += character.length;
	return length;
};

const inlinePatterns = [
	{ kind: "link", pattern: /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/u },
	{ kind: "bold", pattern: /\*\*(.+?)\*\*/u },
	{ kind: "code", pattern: /`([^`]+)`/u },
	{ kind: "italic", pattern: /(?<!\*)\*([^*]+)\*(?!\*)/u },
] as const;

const renderInline = (value: string, baseOffset: number): { readonly text: string; readonly spans: TextSpan[] } => {
	const output: Array<string> = [];
	const spans: Array<TextSpan> = [];
	let cursor = 0;
	let outputOffset = baseOffset;
	while (cursor < value.length) {
		const candidates = inlinePatterns.flatMap(({ kind, pattern }) => {
			const match = pattern.exec(value.slice(cursor));
			return match === null
				? []
				: [{ kind, match, start: cursor + (match.index ?? 0), end: cursor + (match.index ?? 0) + match[0].length }];
		});
		candidates.sort((left, right) => left.start - right.start || left.end - right.end);
		const candidate = candidates[0];
		if (candidate === undefined) {
			output.push(value.slice(cursor));
			break;
		}
		const prefix = value.slice(cursor, candidate.start);
		output.push(prefix);
		outputOffset += utf16Length(prefix);
		const nested = renderInline(candidate.match[1] ?? "", outputOffset);
		output.push(nested.text);
		spans.push(...nested.spans);
		const end = outputOffset + utf16Length(nested.text);
		if (candidate.kind === "link") {
			spans.push({ start: outputOffset, end, style: { link: { url: candidate.match[2] } }, fields: "link" });
		} else if (candidate.kind === "bold") {
			spans.push({ start: outputOffset, end, style: { bold: true }, fields: "bold" });
		} else if (candidate.kind === "italic") {
			spans.push({ start: outputOffset, end, style: { italic: true }, fields: "italic" });
		} else {
			spans.push({
				start: outputOffset,
				end,
				style: { weightedFontFamily: { fontFamily: "Roboto Mono" } },
				fields: "weightedFontFamily",
			});
		}
		outputOffset = end;
		cursor = candidate.end;
	}
	return { text: output.join(""), spans };
};

/** Deterministic, local-only Markdown renderer using Google Docs UTF-16 offsets. */
export const renderMeetingMarkdown = (markdown: string): RenderedMeetingMarkdown => {
	const textParts: Array<string> = [];
	const textSpans: Array<TextSpan> = [];
	const paragraphSpans: Array<ParagraphSpan> = [];
	let offset = 0;
	let inCode = false;
	for (const rawLine of markdown.replace(/\n+$/u, "").split("\n")) {
		if (rawLine.trimStart().startsWith("```")) {
			inCode = !inCode;
			continue;
		}
		let line = rawLine;
		let paragraph: Omit<ParagraphSpan, "start" | "end"> | null = null;
		if (!inCode) {
			const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
			const bullet = /^(\s*)[-*+]\s+(.*)$/u.exec(line);
			const numbered = /^(\s*)\d+[.)]\s+(.*)$/u.exec(line);
			if (heading !== null) {
				line = heading[2] ?? "";
				paragraph = { kind: "heading", value: `HEADING_${heading[1]?.length ?? 1}` };
			} else if (bullet !== null || numbered !== null) {
				const match = bullet ?? numbered;
				const indent = Math.floor((match?.[1] ?? "").replace(/\t/gu, "    ").length / 2);
				line = `${"\t".repeat(indent)}${match?.[2] ?? ""}`;
				paragraph = {
					kind: "bullet",
					value: bullet === null ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE",
				};
			} else if (line.trimStart().startsWith(">")) {
				const leading = line.length - line.trimStart().length;
				line = `${line.slice(0, leading)}${line.trimStart().slice(1).trimStart()}`;
				paragraph = { kind: "quote", value: "NORMAL_TEXT" };
			}
		}
		const lineStart = offset;
		const rendered = inCode ? { text: line, spans: [] } : renderInline(line, lineStart);
		if (inCode && line.length > 0) {
			textSpans.push({
				start: lineStart,
				end: lineStart + utf16Length(line),
				style: { weightedFontFamily: { fontFamily: "Roboto Mono" } },
				fields: "weightedFontFamily",
			});
		}
		textSpans.push(...rendered.spans);
		if (paragraph?.kind === "quote" && rendered.text.length > 0) {
			textSpans.push({
				start: lineStart,
				end: lineStart + utf16Length(rendered.text),
				style: {
					italic: true,
					foregroundColor: { color: { rgbColor: { red: 0.35, green: 0.35, blue: 0.35 } } },
				},
				fields: "italic,foregroundColor",
			});
		}
		const withNewline = `${rendered.text}\n`;
		textParts.push(withNewline);
		offset += utf16Length(withNewline);
		if (paragraph !== null) paragraphSpans.push({ ...paragraph, start: lineStart, end: offset });
	}
	return { text: textParts.join(""), textSpans, paragraphSpans };
};

/** Replace all prior content atomically, then add deterministic paragraph and inline styles. */
export const googleMeetingBatchRequests = (
	rendered: RenderedMeetingMarkdown,
	existingEndIndex: number,
): ReadonlyArray<Readonly<Record<string, unknown>>> => {
	const requests: Array<Readonly<Record<string, unknown>>> = [];
	if (existingEndIndex > 2) {
		requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: existingEndIndex - 1 } } });
	}
	if (rendered.text.length > 0) requests.push({ insertText: { location: { index: 1 }, text: rendered.text } });
	const bulletSpans: Array<ParagraphSpan> = [];
	for (const span of rendered.paragraphSpans) {
		const range = { startIndex: 1 + span.start, endIndex: 1 + span.end };
		if (span.kind === "bullet") {
			bulletSpans.push(span);
			continue;
		}
		requests.push({
			updateParagraphStyle: {
				range,
				paragraphStyle:
					span.kind === "quote"
						? { namedStyleType: span.value, indentStart: { magnitude: 18, unit: "PT" } }
						: { namedStyleType: span.value },
				fields: span.kind === "quote" ? "namedStyleType,indentStart" : "namedStyleType",
			},
		});
	}
	for (const span of rendered.textSpans) {
		if (span.end <= span.start) continue;
		requests.push({
			updateTextStyle: {
				range: { startIndex: 1 + span.start, endIndex: 1 + span.end },
				textStyle: span.style,
				fields: span.fields,
			},
		});
	}
	for (const span of bulletSpans.sort((left, right) => right.start - left.start)) {
		requests.push({
			createParagraphBullets: {
				range: { startIndex: 1 + span.start, endIndex: 1 + span.end },
				bulletPreset: span.value,
			},
		});
	}
	return requests;
};
