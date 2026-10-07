import { posix } from "node:path";
import type { WikiCitation, WikiClaim, WikiEvidence, WikiPageProposal, WikiSynthesisResult } from "@harnessy/core/wiki";
import { hash, type WikiStore } from "./store.ts";

const object = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected synthesis object");
	return value as Record<string, unknown>;
};
const plain = (value: unknown, max = 2000): string => {
	if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n<>[\]`]|!\(|https?:\/\//i.test(value))
		throw new Error("Expected bounded plain synthesis text");
	return value;
};
const list = (value: unknown, max: number): unknown[] => {
	if (!Array.isArray(value) || value.length > max) throw new Error("Invalid synthesis list");
	return value;
};

/** Verifies existence and exact quotations, not entailment or truth. All citations must
 * refer to the bounded evidence actually supplied to this model invocation. */
export function validateSynthesis(
	raw: unknown,
	evidence: readonly WikiEvidence[],
	existing: readonly string[],
): WikiSynthesisResult {
	const pages: WikiPageProposal[] = list(object(raw).pages, 16).map((value) => {
		const page = object(value);
		const path = plain(page.path, 160);
		if (!/^(?:questions|topics\/[a-z0-9-]+|concepts\/[a-z0-9-]+|reviews\/\d{4}-W\d{2})\.md$/.test(path))
			throw new Error(`Invalid proposed page: ${path}`);
		const claims: WikiClaim[] = list(page.claims, 50).map((value) => {
			const claim = object(value);
			const kind = plain(claim.kind) as WikiClaim["kind"];
			if (!["finding", "agreement", "disagreement", "connection", "implication", "question", "gap"].includes(kind))
				throw new Error("Unknown claim kind");
			const citations: WikiCitation[] = list(claim.citations, 12).map((value) => {
				const citation = object(value);
				if (
					typeof citation.versionId !== "string" ||
					typeof citation.locator !== "string" ||
					typeof citation.quote !== "string" ||
					citation.quote.trim().length < 8 ||
					citation.quote.length > 1800
				)
					throw new Error("Invalid citation");
				const version = evidence.find((item) => item.version.id === citation.versionId)?.version;
				const passage = version?.passages.find((item) => item.locator === citation.locator);
				if (!passage || !passage.text.includes(citation.quote))
					throw new Error("Citation does not match supplied evidence");
				return { versionId: citation.versionId, locator: citation.locator, quote: citation.quote };
			});
			if (!["question", "gap"].includes(kind) && !citations.length) throw new Error("Material claim lacks citation");
			if (
				["agreement", "disagreement", "connection"].includes(kind) &&
				new Set(
					citations.map((citation) => evidence.find((item) => item.version.id === citation.versionId)?.source.id),
				).size < 2
			)
				throw new Error("Cross-source claim requires two sources");
			return { text: plain(claim.text), kind, citations };
		});
		if (!claims.length) throw new Error("Empty proposed page");
		return {
			path,
			title: plain(page.title, 200),
			topics: list(page.topics, 12).map((value) => plain(value, 300)),
			claims,
			links: list(page.links, 20).map((value) => plain(value, 160)),
		};
	});
	if (!pages.length || new Set(pages.map((page) => page.path)).size !== pages.length)
		throw new Error("Empty or duplicate proposed pages");
	const known = new Set([...existing, ...pages.map((page) => page.path)]);
	for (const page of pages)
		for (const link of page.links)
			if (!known.has(link) || link.includes("..")) throw new Error(`Unresolved wiki link: ${link}`);
	return { pages };
}

export const escapeMarkdown = (value: string): string => value.replace(/[\\`*_{}[\]()#+.!|<>-]/g, "\\$&");
const relativeLink = (from: string, to: string) => posix.relative(posix.dirname(from), to);
export const frontmatter = (
	title: string,
	type: string,
	topics: readonly string[],
	versions: readonly string[],
): string =>
	`---\nokf_version: "0.2"\ntitle: ${JSON.stringify(title)}\ntype: ${type}\ndescription: ${JSON.stringify(title)}\ntags: ${JSON.stringify(topics)}\nsources: ${JSON.stringify(versions.map((id) => ({ id, resource: `harnessy://wiki/versions/${id}` })))}\ngenerated: ${JSON.stringify({ by: "harnessy/0.0.3", at: new Date().toISOString() })}\n---\n\n# ${escapeMarkdown(title)}\n\n`;

export function renderPage(page: WikiPageProposal): string {
	const versions = [...new Set(page.claims.flatMap((claim) => claim.citations.map((citation) => citation.versionId)))];
	return (
		frontmatter(page.title, "Reference", page.topics, versions) +
		page.claims
			.map((claim) => {
				const citations = claim.citations
					.map(
						(citation) =>
							`[${citation.versionId.slice(0, 8)}:${citation.locator}](${relativeLink(page.path, `sources/${citation.versionId}.md`)}#${citation.locator})`,
					)
					.join(" ");
				return `- **${claim.kind}**: ${escapeMarkdown(claim.text)} ${citations}`.trimEnd();
			})
			.join("\n\n") +
		(page.links.length
			? `\n\n## Related pages\n\n${page.links.map((link) => `- [${escapeMarkdown(link)}](${relativeLink(page.path, link)})`).join("\n")}`
			: "") +
		"\n"
	);
}

export function sourcePage(evidence: WikiEvidence): string {
	const { source, version } = evidence;
	return (
		frontmatter(source.title, "Reference", source.topics, [version.id]) +
		`Provenance: ${escapeMarkdown(source.uri)}\n\nVersion: ${version.id}; captured: ${version.fetchedAt}; evidence: ${version.mode}.\n\n` +
		version.passages
			.map((passage) => `## ${passage.locator}\n\n> ${escapeMarkdown(passage.text).replaceAll("\n", "\n> ")}`)
			.join("\n\n") +
		"\n"
	);
}

/** Keep metadata timestamps stable when semantic content is unchanged. */
export function stablePage(store: WikiStore, path: string, markdown: string, expected: string | null): boolean {
	const old = store.pages().find((page) => page.path === path);
	const semantic = (value: string) => value.replace(/^generated: .*\n/gm, "");
	if (old && hash(semantic(old.markdown)) === hash(semantic(markdown))) {
		if (store.pageHash(path) !== old.digest) throw new Error(`Manual edit conflict: ${path}`);
		return false;
	}
	return store.applyPage(path, markdown, expected);
}

export function boundedEvidence(evidence: readonly WikiEvidence[]): WikiEvidence[] {
	const perSource = Math.floor(65_000 / Math.max(1, Math.min(10, evidence.length)));
	return evidence
		.slice(0, 10)
		.map((item) => {
			let remaining = perSource;
			const passages = item.version.passages.slice(0, 24).filter((passage) => {
				if (remaining < passage.text.length) return false;
				remaining -= passage.text.length;
				return true;
			});
			return { source: item.source, version: { ...item.version, passages } };
		})
		.filter((item) => item.version.passages.length > 0);
}
