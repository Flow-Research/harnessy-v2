import { describe, expect, it } from "@effect/vitest";

import {
	redactMeetingPublicationReviewText,
	renderMeetingPublicationReviewMarkdown,
	renderMeetingPublicationReviewNote,
} from "../src/jarvis/meeting-publication/review-markdown.ts";

describe("meeting publication review Markdown", () => {
	it("collapses metadata and omits the duplicate title without changing note input", () => {
		const input = `# Weekly sync

## Metadata
- Project: **Example**
- [Source][meeting]

## Executive Summary
Ready for review.

[meeting]: https://example.test/meeting
`;
		const rendered = renderMeetingPublicationReviewNote(input);
		expect(rendered).toContain('<details class="metadata-card"><summary>Meeting metadata</summary>');
		expect(rendered).not.toContain("<details open");
		expect(rendered).toContain("Project: <strong>Example</strong>");
		expect(rendered).toContain('href="https://example.test/meeting"');
		expect(rendered).toContain("</details><h2>Executive Summary</h2>");
		expect(rendered).not.toContain("<h1>Weekly sync</h1>");
		expect(input).toContain("# Weekly sync");
		expect(input).toContain("## Metadata");
	});

	it("does not split heading-like code or hide ordinary sections", () => {
		const rendered = renderMeetingPublicationReviewNote(`## Executive Summary
Visible summary.

\`\`\`markdown
## Metadata
Keep this example in the note.
\`\`\`

## Decisions
Visible decision.
`);
		expect(rendered).not.toContain("<details");
		expect(rendered).toContain("## Metadata\nKeep this example in the note.");
		expect(rendered).toContain("<h2>Executive Summary</h2>");
		expect(rendered).toContain("<h2>Decisions</h2>");
	});

	it("keeps metadata safe and omits an empty disclosure", () => {
		const rendered = renderMeetingPublicationReviewNote(`# Meeting
## Metadata
<script>alert(1)</script>

token=PRIVATE_VALUE

## Summary
![Remote](https://tracker.example/image)
`);
		expect(rendered).toContain("&lt;script&gt;");
		expect(rendered).not.toContain("<script");
		expect(rendered).not.toContain("PRIVATE_VALUE");
		expect(rendered).not.toContain("tracker.example");
		expect(renderMeetingPublicationReviewNote("# Meeting\n\n## Metadata\n\n## Summary\nText")).not.toContain(
			"<details",
		);
	});

	it("renders the CommonMark structure needed by meeting notes", () => {
		const rendered = renderMeetingPublicationReviewMarkdown(`# Weekly sync

We **approved** the *release* with \`npm test\`.

- First item
- Second item

1. Prepare
2. Review

> Local review only.
`);

		expect(rendered).toContain("<h1>Weekly sync</h1>");
		expect(rendered).toContain("<strong>approved</strong>");
		expect(rendered).toContain("<em>release</em>");
		expect(rendered).toContain("<code>npm test</code>");
		expect(rendered).toContain("<ul>");
		expect(rendered).toContain("<ol>");
		expect(rendered).toContain("<blockquote>");
	});

	it("escapes raw HTML and code while preserving ordinary entities", () => {
		const rendered = renderMeetingPublicationReviewMarkdown(`# Safety &amp; review

<script>alert("raw")</script>

<img src="https://tracker.example/pixel" onerror="alert(1)">

An entity stays readable: &copy; and &#169;.

Inline \`<svg onload="alert(2)">\`.

\`\`\`
<iframe src="https://tracker.example/frame"></iframe>
\`\`\`
`);

		expect(rendered).toContain("<h1>Safety &amp; review</h1>");
		expect(rendered).toContain("&lt;script&gt;alert(&quot;raw&quot;)&lt;/script&gt;");
		expect(rendered).toContain("&lt;img src=&quot;https://tracker.example/pixel&quot;");
		expect(rendered).toContain("&copy; and &#169;");
		expect(rendered).toContain("<code>&lt;svg onload=&quot;alert(2)&quot;&gt;</code>");
		expect(rendered).toContain("&lt;iframe src=&quot;https://tracker.example/frame&quot;&gt;");
		expect(rendered).not.toContain("<script");
		expect(rendered).not.toContain("<img");
		expect(rendered).not.toContain("<iframe");
		expect(rendered).not.toContain("<svg");
	});

	it("keeps only absolute HTTP links and escapes their labels and attributes", () => {
		const rendered = renderMeetingPublicationReviewMarkdown(`
[HTTPS <safe>](https://example.test/a?one=1&two=2 'title "quoted" & more')
[HTTP](http://example.test/path)
[mail](mailto:owner@example.test)
[relative](/item/abc)
[fragment](#review)
[protocol relative](//example.test/path)
[javascript](javascript:alert(1))
[data](data:text/html,<script>alert(2)</script>)
`);

		expect(rendered).toContain(
			'<a href="https://example.test/a?one=1&amp;two=2" title="title &quot;quoted&quot; &amp; more" rel="noreferrer">HTTPS &lt;safe&gt;</a>',
		);
		expect(rendered).toContain('<a href="http://example.test/path" rel="noreferrer">HTTP</a>');
		expect(rendered.match(/<a /gu)).toHaveLength(2);
		for (const label of ["mail", "relative", "fragment", "protocol relative", "javascript", "data"]) {
			expect(rendered).toContain(label);
		}
		expect(rendered).not.toContain("mailto:");
		expect(rendered).not.toContain('href="/');
		expect(rendered).not.toContain('href="#');
		expect(rendered).not.toContain("javascript:");
		expect(rendered).not.toContain("data:text/html");
	});

	it("renders image alternatives without loading a resource", () => {
		const rendered = renderMeetingPublicationReviewMarkdown(`
![Architecture <draft>](https://tracker.example/diagram.png "remote")
![](https://tracker.example/blank.png)
`);

		expect(rendered).toContain("[Image: Architecture &lt;draft&gt;]");
		expect(rendered).toContain("[Image]");
		expect(rendered).not.toContain("<img");
		expect(rendered).not.toContain("tracker.example");
	});

	it("redacts unsafe links and credential-shaped assignments before parsing", () => {
		const input = `Public text javascript:alert(1) token=TOP_SECRET

\`credential:INLINE_SECRET\`

[unsafe](data:text/html,SECRET_PAYLOAD)
`;
		const redacted = redactMeetingPublicationReviewText(input);
		const rendered = renderMeetingPublicationReviewMarkdown(input);

		expect(redacted).toContain("[unsafe link removed]");
		expect(redacted).toContain("[credential removed]");
		for (const secret of ["TOP_SECRET", "INLINE_SECRET", "SECRET_PAYLOAD", "javascript:", "data:text/html"]) {
			expect(redacted).not.toContain(secret);
			expect(rendered).not.toContain(secret);
		}
		expect(rendered).toContain("[unsafe link removed]");
		expect(rendered).toContain("[credential removed]");
	});
});
