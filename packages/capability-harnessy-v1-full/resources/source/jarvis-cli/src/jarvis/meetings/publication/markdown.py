"""Small deterministic Markdown-to-Google-Docs formatter."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^)]+)\)")
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_CODE_RE = re.compile(r"`([^`]+)`")
_ITALIC_RE = re.compile(r"(?<!\*)\*([^*]+)\*(?!\*)")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
_BULLET_RE = re.compile(r"^(\s*)[-*+]\s+(.*)$")
_NUMBER_RE = re.compile(r"^(\s*)\d+[.)]\s+(.*)$")


def utf16_len(value: str) -> int:
    """Return the index length used by the Google Docs API."""

    return len(value.encode("utf-16-le")) // 2


@dataclass(frozen=True, slots=True)
class TextSpan:
    """A text-style span using zero-based UTF-16 offsets."""

    start: int
    end: int
    style: dict[str, object]
    fields: str


@dataclass(frozen=True, slots=True)
class ParagraphSpan:
    """A paragraph-style or list span using zero-based UTF-16 offsets."""

    start: int
    end: int
    kind: str
    value: str


@dataclass(slots=True)
class RenderedDocument:
    """Plain Google Docs text plus formatting ranges."""

    text: str = ""
    text_spans: list[TextSpan] = field(default_factory=list)
    paragraph_spans: list[ParagraphSpan] = field(default_factory=list)


def render_markdown(markdown: str) -> RenderedDocument:
    """Render common meeting-note Markdown without sending it through another service."""

    output = RenderedDocument()
    text_parts: list[str] = []
    offset = 0
    in_code = False

    for raw_line in markdown.rstrip("\n").splitlines():
        if raw_line.strip().startswith("```"):
            in_code = not in_code
            continue

        paragraph_kind = ""
        paragraph_value = ""
        line = raw_line
        heading = _HEADING_RE.match(line)
        bullet = _BULLET_RE.match(line)
        number = _NUMBER_RE.match(line)
        if heading and not in_code:
            level = min(len(heading.group(1)), 6)
            line = heading.group(2)
            paragraph_kind = "heading"
            paragraph_value = f"HEADING_{level}"
        elif bullet and not in_code:
            indent = len(bullet.group(1).replace("\t", "    ")) // 2
            line = "\t" * indent + bullet.group(2)
            paragraph_kind = "bullet"
            paragraph_value = "BULLET_DISC_CIRCLE_SQUARE"
        elif number and not in_code:
            indent = len(number.group(1).replace("\t", "    ")) // 2
            line = "\t" * indent + number.group(2)
            paragraph_kind = "bullet"
            paragraph_value = "NUMBERED_DECIMAL_ALPHA_ROMAN"
        elif line.lstrip().startswith(">") and not in_code:
            leading = len(line) - len(line.lstrip())
            line = line[:leading] + line.lstrip()[1:].lstrip()
            paragraph_kind = "quote"
            paragraph_value = "NORMAL_TEXT"

        line_start = offset
        if in_code:
            rendered_line = line
            spans = (
                [
                    TextSpan(
                        start=line_start,
                        end=line_start + utf16_len(line),
                        style={"weightedFontFamily": {"fontFamily": "Roboto Mono"}},
                        fields="weightedFontFamily",
                    )
                ]
                if line
                else []
            )
        else:
            rendered_line, spans = _render_inline(line, base_offset=line_start)
            if paragraph_kind == "quote" and rendered_line:
                spans.append(
                    TextSpan(
                        start=line_start,
                        end=line_start + utf16_len(rendered_line),
                        style={
                            "italic": True,
                            "foregroundColor": {
                                "color": {"rgbColor": {"red": 0.35, "green": 0.35, "blue": 0.35}}
                            },
                        },
                        fields="italic,foregroundColor",
                    )
                )

        rendered_with_newline = rendered_line + "\n"
        text_parts.append(rendered_with_newline)
        line_end = line_start + utf16_len(rendered_with_newline)
        output.text_spans.extend(spans)
        if paragraph_kind:
            output.paragraph_spans.append(
                ParagraphSpan(line_start, line_end, paragraph_kind, paragraph_value)
            )
        offset = line_end

    output.text = "".join(text_parts)
    return output


def _render_inline(value: str, *, base_offset: int) -> tuple[str, list[TextSpan]]:
    """Remove common inline syntax while retaining style and link ranges."""

    output: list[str] = []
    spans: list[TextSpan] = []
    cursor = 0
    out_offset = base_offset

    while cursor < len(value):
        candidates: list[tuple[int, int, str, re.Match[str]]] = []
        for kind, pattern in (
            ("link", _LINK_RE),
            ("bold", _BOLD_RE),
            ("code", _CODE_RE),
            ("italic", _ITALIC_RE),
        ):
            match = pattern.search(value, cursor)
            if match:
                candidates.append((match.start(), match.end(), kind, match))
        if not candidates:
            tail = value[cursor:]
            output.append(tail)
            break
        start, end, kind, match = min(candidates, key=lambda item: (item[0], item[1]))
        prefix = value[cursor:start]
        output.append(prefix)
        out_offset += utf16_len(prefix)

        inner = match.group(1)
        rendered_inner, nested = _render_inline(inner, base_offset=out_offset)
        output.append(rendered_inner)
        inner_end = out_offset + utf16_len(rendered_inner)
        spans.extend(nested)
        if kind == "link":
            spans.append(
                TextSpan(
                    out_offset,
                    inner_end,
                    {"link": {"url": match.group(2)}},
                    "link",
                )
            )
        elif kind == "bold":
            spans.append(TextSpan(out_offset, inner_end, {"bold": True}, "bold"))
        elif kind == "italic":
            spans.append(TextSpan(out_offset, inner_end, {"italic": True}, "italic"))
        else:
            spans.append(
                TextSpan(
                    out_offset,
                    inner_end,
                    {"weightedFontFamily": {"fontFamily": "Roboto Mono"}},
                    "weightedFontFamily",
                )
            )
        out_offset = inner_end
        cursor = end
    return "".join(output), spans


def google_batch_requests(
    rendered: RenderedDocument, *, existing_end_index: int | None = None
) -> list[dict[str, object]]:
    """Build an atomic Docs batch update for replacement plus formatting."""

    requests: list[dict[str, object]] = []
    if existing_end_index is not None and existing_end_index > 2:
        requests.append(
            {"deleteContentRange": {"range": {"startIndex": 1, "endIndex": existing_end_index - 1}}}
        )
    if rendered.text:
        requests.append({"insertText": {"location": {"index": 1}, "text": rendered.text}})
    bullet_spans: list[ParagraphSpan] = []
    for paragraph_span in rendered.paragraph_spans:
        range_value = {
            "startIndex": 1 + paragraph_span.start,
            "endIndex": 1 + paragraph_span.end,
        }
        if paragraph_span.kind == "bullet":
            bullet_spans.append(paragraph_span)
            continue
        style: dict[str, object] = {"namedStyleType": paragraph_span.value}
        fields = "namedStyleType"
        if paragraph_span.kind == "quote":
            style["indentStart"] = {"magnitude": 18, "unit": "PT"}
            fields += ",indentStart"
        requests.append(
            {
                "updateParagraphStyle": {
                    "range": range_value,
                    "paragraphStyle": style,
                    "fields": fields,
                }
            }
        )
    for text_span in rendered.text_spans:
        if text_span.end <= text_span.start:
            continue
        requests.append(
            {
                "updateTextStyle": {
                    "range": {
                        "startIndex": 1 + text_span.start,
                        "endIndex": 1 + text_span.end,
                    },
                    "textStyle": text_span.style,
                    "fields": text_span.fields,
                }
            }
        )
    # Google removes leading tabs when applying list nesting. Apply every other
    # index-based style first, then create bullets from the end of the document
    # so those removals cannot invalidate a later request range.
    for paragraph_span in sorted(bullet_spans, key=lambda span: span.start, reverse=True):
        requests.append(
            {
                "createParagraphBullets": {
                    "range": {
                        "startIndex": 1 + paragraph_span.start,
                        "endIndex": 1 + paragraph_span.end,
                    },
                    "bulletPreset": paragraph_span.value,
                }
            }
        )
    return requests
