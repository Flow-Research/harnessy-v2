import { createHash } from "node:crypto";

import { LifeOrchestratorError, type LifeReadingInput } from "./models.ts";

const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src", "source"]);

const stripArxivVersion = (identifier: string) => identifier.replace(/v\d+$/i, "");

const arxivIdentifier = (url: URL): string | null => {
	if (url.hostname !== "arxiv.org" && url.hostname !== "export.arxiv.org") return null;
	const match = url.pathname.match(/^\/(?:abs|pdf)\/([^/?#]+?)(?:\.pdf)?$/i);
	return match?.[1] === undefined ? null : stripArxivVersion(decodeURIComponent(match[1])).toLowerCase();
};

const doiIdentifier = (url: URL): string | null => {
	if (url.hostname !== "doi.org" && url.hostname !== "dx.doi.org") return null;
	const value = decodeURIComponent(url.pathname.replace(/^\/+/, "")).replace(/^doi:/i, "").trim();
	return value.length === 0 ? null : value.toLowerCase();
};

/** Canonicalize an article URL while preserving semantically meaningful query parameters. */
export const canonicalizeReadingUrl = (rawUrl: string): string => {
	const value = rawUrl.trim();
	if (!URL.canParse(value)) {
		throw new LifeOrchestratorError({ code: "invalid_url", message: `Invalid reading URL: ${rawUrl}` });
	}
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new LifeOrchestratorError({
			code: "invalid_url",
			message: `Unsupported reading URL protocol: ${url.protocol}`,
		});
	}
	url.protocol = "https:";
	url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
	url.hash = "";
	if (url.port === "80" || url.port === "443") url.port = "";

	const arxiv = arxivIdentifier(url);
	if (arxiv !== null) return `https://arxiv.org/abs/${arxiv}`;
	const doi = doiIdentifier(url);
	if (doi !== null) return `https://doi.org/${doi}`;

	for (const key of Array.from(url.searchParams.keys())) {
		if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
			url.searchParams.delete(key);
		}
	}
	url.searchParams.sort();
	url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
	return url.toString();
};

const normalizedSourceId = (candidate: LifeReadingInput): string | null => {
	const sourceId = candidate.sourceId?.trim();
	if (sourceId === undefined || sourceId.length === 0) return null;
	if (sourceId.toLowerCase().startsWith("doi:")) {
		return `doi:${sourceId.slice(4).trim().toLowerCase()}`;
	}
	if (sourceId.toLowerCase().startsWith("arxiv:")) {
		return `arxiv:${stripArxivVersion(sourceId.slice(6).trim()).toLowerCase()}`;
	}
	return `${candidate.sourceKind}:${sourceId.toLowerCase()}`;
};

/** Stable article identity: publisher identifiers first, canonical URL digest otherwise. */
export const readingIdentity = (
	candidate: LifeReadingInput,
): { readonly identity: string; readonly canonicalUrl: string } => {
	const canonicalUrl = canonicalizeReadingUrl(candidate.url);
	const explicit = normalizedSourceId(candidate);
	if (explicit !== null) return { identity: explicit, canonicalUrl };
	const url = new URL(canonicalUrl);
	const arxiv = arxivIdentifier(url);
	if (arxiv !== null) return { identity: `arxiv:${arxiv}`, canonicalUrl };
	const doi = doiIdentifier(url);
	if (doi !== null) return { identity: `doi:${doi}`, canonicalUrl };
	return {
		identity: `url:${createHash("sha256").update(canonicalUrl).digest("hex")}`,
		canonicalUrl,
	};
};
