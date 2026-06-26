import { createHash } from "node:crypto";

import { Path, Schema } from "effect";
import * as Effect from "effect/Effect";

import { CAPABILITY_MANIFEST_NAME, CapabilityManifest } from "./capability-manifest.ts";
import { causeMessage, HarnessError } from "./errors.ts";
import { expandHomePath } from "./paths.ts";

/** Supported source classes for zero-effort capability installation. */
export const CapabilitySourceType = Schema.Literals(["git", "npm", "url", "local"]);

/** Supported source classes for zero-effort capability installation. */
export type CapabilitySourceType = typeof CapabilitySourceType.Type;

/** URL payload classes Harnessy can plan without fetching. */
export const CapabilityUrlArtifactKind = Schema.Literals(["manifest", "archive"]);

/** URL payload classes Harnessy can plan without fetching. */
export type CapabilityUrlArtifactKind = typeof CapabilityUrlArtifactKind.Type;

/** Remote fetch classes represented by a deterministic resolution plan. */
export const CapabilityRemoteFetchType = Schema.Literals(["git", "npm", "url-manifest", "url-archive"]);

/** Remote fetch classes represented by a deterministic resolution plan. */
export type CapabilityRemoteFetchType = typeof CapabilityRemoteFetchType.Type;

/** User-provided source for a capability package. */
export class CapabilitySource extends Schema.Class<CapabilitySource>("CapabilitySource")({
	/** Source transport type inferred from the input string. */
	type: CapabilitySourceType,
	/** Original normalized source value recorded in the lockfile. */
	value: Schema.String,
}) {}

/** A local source root and its expected capability manifest path. */
export class CapabilityLocalResolution extends Schema.Class<CapabilityLocalResolution>("CapabilityLocalResolution")({
	/** Absolute local capability root to inspect for a manifest. */
	root: Schema.String,
	/** Absolute expected manifest path below the local root. */
	manifestPath: Schema.String,
}) {}

/** Remote source metadata needed by later fetch/materialization code. */
export class CapabilityRemoteFetch extends Schema.Class<CapabilityRemoteFetch>("CapabilityRemoteFetch")({
	/** Fetch mechanism required to materialize the capability. */
	type: CapabilityRemoteFetchType,
	/** Fetch locator with refs/fragments split into structured fields where applicable. */
	locator: Schema.String,
	/** Git ref or URL fragment selector, when the source included one. */
	ref: Schema.NullOr(Schema.String),
	/** Parsed npm package name for npm sources. */
	packageName: Schema.optional(Schema.String),
	/** Parsed npm version/range/tag specifier for npm sources. */
	packageSpec: Schema.optional(Schema.String),
	/** URL payload class for URL sources. */
	urlKind: Schema.optional(CapabilityUrlArtifactKind),
}) {}

/** Deterministic source resolution plan that performs no network or shell work. */
export class CapabilityResolutionPlan extends Schema.Class<CapabilityResolutionPlan>("CapabilityResolutionPlan")({
	/** Caller-provided source after parsing but before target-local normalization. */
	source: CapabilitySource,
	/** Canonical source identity used for cache keys and future materialization. */
	normalizedSource: CapabilitySource,
	/** Stable default capability id derived from the source unless the caller overrides it. */
	id: Schema.String,
	/** Path-component-safe slug derived from the capability id. */
	slug: Schema.String,
	/** Path-component-safe cache slug derived from the normalized source identity. */
	cacheSlug: Schema.String,
	/** Whether a future materializer must fetch remote content before reading a manifest. */
	requiresFetch: Schema.Boolean,
	/** Local manifest root metadata, present only for local sources. */
	local: Schema.NullOr(CapabilityLocalResolution),
	/** Remote fetch metadata, present only for sources that require fetch/materialization. */
	remote: Schema.NullOr(CapabilityRemoteFetch),
}) {}

/** Stable fingerprint metadata persisted in the lockfile without listing every file. */
export class CapabilityFingerprintMetadata extends Schema.Class<CapabilityFingerprintMetadata>(
	"CapabilityFingerprintMetadata",
)({
	/** Absolute local root that was fingerprinted. */
	root: Schema.String,
	/** File or directory fingerprint kind. */
	kind: Schema.Literals(["file", "directory"]),
	/** Stable SHA-256 digest for the file or deterministic directory tree. */
	sha256: Schema.String,
	/** Sum of included file byte lengths. */
	bytes: Schema.Number,
	/** Count of deterministic file entries included in the fingerprint. */
	fileCount: Schema.Number,
	/** Non-fatal skipped paths such as symlinks. */
	issues: Schema.Array(Schema.String),
}) {}

/** A lockfile entry for one installed or recorded capability. */
export class CapabilityEntry extends Schema.Class<CapabilityEntry>("CapabilityEntry")({
	/** Stable lockfile identifier, namespaced by source type. */
	id: Schema.String,
	/** Where Harnessy should resolve or fetch the capability from. */
	source: CapabilitySource,
	/** Deterministic source-resolution metadata recorded at add/materialize time. */
	resolvedSource: Schema.optional(CapabilityResolutionPlan),
	/** Local content fingerprint metadata recorded for local capability sources. */
	fingerprint: Schema.optional(CapabilityFingerprintMetadata),
	/** ISO timestamp for when the capability was recorded. */
	addedAt: Schema.String,
	/** Optional metadata read from a capability-owned manifest file. */
	manifest: Schema.optional(CapabilityManifest),
}) {}

const URL_PREFIX = "url:";
const HTTP_URL_PATTERN = /^https?:\/\//i;
const URL_LIKE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

const hasUrlPrefix = (value: string): boolean => value.toLowerCase().startsWith(URL_PREFIX);

const stripUrlPrefix = (value: string): string =>
	hasUrlPrefix(value) ? value.slice(URL_PREFIX.length).trim() : value.trim();

const parseHttpUrl = (value: string, original: string) =>
	Effect.try({
		try: () => {
			const url = new URL(value);
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				throw new Error(`Unsupported URL protocol ${url.protocol}`);
			}
			return url;
		},
		catch: (cause) =>
			new HarnessError({
				message: `Invalid URL capability source ${original}: ${causeMessage(cause)}`,
				cause,
			}),
	});

const normalizeHttpUrlParts = Effect.fn("CapabilitySource.normalizeHttpUrl")(function* (value: string) {
	const raw = stripUrlPrefix(value);
	const url = yield* parseHttpUrl(raw, value);
	const normalizedValue = url.toString();
	const ref = url.hash.length > 0 ? url.hash.slice(1) : null;
	url.hash = "";
	return {
		normalizedValue,
		locator: url.toString(),
		ref,
		pathname: url.pathname,
		hostname: url.hostname,
	} as const;
});

const splitSourceRef = (value: string): { readonly locator: string; readonly ref: string | null } => {
	const marker = value.indexOf("#");
	if (marker === -1) return { locator: value, ref: null };
	const ref = value.slice(marker + 1);
	return { locator: value.slice(0, marker), ref: ref.length > 0 ? ref : null };
};

const normalizeGitLocator = (locator: string): string => {
	const withoutGitPrefix = locator.startsWith("git+") ? locator.slice("git+".length) : locator;
	if (!URL_LIKE_PATTERN.test(withoutGitPrefix)) return withoutGitPrefix;
	return URL.canParse(withoutGitPrefix) ? new URL(withoutGitPrefix).toString() : withoutGitPrefix;
};

const normalizeGitParts = (value: string): { readonly locator: string; readonly ref: string | null } => {
	const parts = splitSourceRef(value.trim());
	return { locator: normalizeGitLocator(parts.locator), ref: parts.ref };
};

const normalizeGitSourceValue = (value: string): string => {
	const parts = normalizeGitParts(value);
	return parts.ref === null ? parts.locator : `${parts.locator}#${parts.ref}`;
};

const normalizeNpmSourceValue = (value: string): string =>
	(value.startsWith("npm:") ? value.slice("npm:".length) : value).trim();

const parseNpmPackageSpec = (value: string): { readonly packageName: string; readonly packageSpec: string | null } => {
	const normalized = normalizeNpmSourceValue(value);
	if (normalized.startsWith("@")) {
		const scopeSlash = normalized.indexOf("/");
		if (scopeSlash === -1) return { packageName: normalized, packageSpec: null };
		const versionMarker = normalized.indexOf("@", scopeSlash + 1);
		if (versionMarker === -1) return { packageName: normalized, packageSpec: null };
		const packageSpec = normalized.slice(versionMarker + 1);
		return {
			packageName: normalized.slice(0, versionMarker),
			packageSpec: packageSpec.length > 0 ? packageSpec : null,
		};
	}

	const versionMarker = normalized.indexOf("@", 1);
	if (versionMarker === -1) return { packageName: normalized, packageSpec: null };
	const packageSpec = normalized.slice(versionMarker + 1);
	return {
		packageName: normalized.slice(0, versionMarker),
		packageSpec: packageSpec.length > 0 ? packageSpec : null,
	};
};

const urlFetchType = (pathname: string): CapabilityRemoteFetchType => {
	const lowerPathname = pathname.toLowerCase();
	if (lowerPathname.endsWith(`/${CAPABILITY_MANIFEST_NAME}`) || lowerPathname.endsWith(".json")) {
		return "url-manifest";
	}
	return "url-archive";
};

/** Infer whether a capability source should be resolved as git, npm, url, or local path. */
export const parseCapabilitySource = Effect.fn("CapabilitySource.parse")(function* (source: string) {
	const value = source.trim();
	if (value.length === 0) {
		return yield* new HarnessError({ message: "Capability source cannot be empty." });
	}

	if (hasUrlPrefix(value)) {
		const url = yield* normalizeHttpUrlParts(value);
		return new CapabilitySource({ type: "url", value: url.normalizedValue });
	}

	if (
		value.startsWith("git+") ||
		value.startsWith("ssh://") ||
		value.startsWith("git@") ||
		/^(https?:\/\/).+\.git(?:#.+)?$/.test(value)
	) {
		return new CapabilitySource({ type: "git", value });
	}

	if (value.startsWith(".") || value.startsWith("/") || value.startsWith("~")) {
		return new CapabilitySource({ type: "local", value });
	}

	if (HTTP_URL_PATTERN.test(value)) {
		const url = yield* normalizeHttpUrlParts(value);
		return new CapabilitySource({ type: "url", value: url.normalizedValue });
	}

	return new CapabilitySource({ type: "npm", value: normalizeNpmSourceValue(value) });
});

/** Remove common git suffix and ref notation before deriving a friendly name. */
const stripGitSuffix = (value: string): string => value.replace(/\.git(?:#.+)?$/, "").replace(/#.+$/, "");

/** Derive a display-safe default capability name from a source. */
export const defaultCapabilityName = Effect.fn("CapabilitySource.defaultName")(function* (source: CapabilitySource) {
	if (source.type === "npm") return source.value.split("/").filter(Boolean).join("-");

	const path = yield* Path.Path;
	if (source.type === "git") {
		const cleaned = stripGitSuffix(source.value);
		return path.basename(cleaned.replaceAll(":", "/"));
	}

	if (source.type === "url") {
		const url = yield* normalizeHttpUrlParts(source.value);
		const basename = path.basename(url.pathname);
		return basename.length > 0 ? basename : url.hostname;
	}

	const expanded = yield* expandHomePath(source.value);
	return path.basename(expanded);
});

/** Convert a string into a stable artifact/cache-safe slug. */
export const makeCapabilitySlug = (value: string): string => {
	const safeName = value
		.trim()
		.toLowerCase()
		.replace(/^@/, "")
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return safeName.length > 0 ? safeName : "capability";
};

/** Convert a source type and name into a stable lockfile capability id. */
export const makeCapabilityId = (type: CapabilitySourceType, name: string): string =>
	`${type}:${makeCapabilitySlug(name)}`;

/** Convert a normalized source identity into a bounded cache-safe slug. */
export const makeCapabilityCacheSlug = (source: CapabilitySource): string => {
	const identity = `${source.type}:${source.value}`;
	const base = makeCapabilitySlug(identity).slice(0, 80) || "capability";
	const hash = createHash("sha256").update(identity).digest("hex").slice(0, 12);
	return `${base}-${hash}`;
};

/** Resolve a local capability source to an absolute path, or return null for remote sources. */
export const localCapabilityPath = Effect.fn("CapabilitySource.localPath")(function* (
	targetDir: string,
	source: CapabilitySource,
) {
	if (source.type !== "local") return null;
	const path = yield* Path.Path;
	const expanded = yield* expandHomePath(source.value);
	return path.isAbsolute(expanded) ? expanded : path.resolve(targetDir, expanded);
});

/** Normalize a parsed source into a deterministic identity for resolution and caching. */
export const normalizeCapabilitySource = Effect.fn("CapabilitySource.normalize")(function* (
	targetDir: string,
	source: CapabilitySource,
) {
	if (source.type === "local") {
		const value = yield* localCapabilityPath(targetDir, source);
		return new CapabilitySource({ type: "local", value: value ?? source.value });
	}

	if (source.type === "git") {
		return new CapabilitySource({ type: "git", value: normalizeGitSourceValue(source.value) });
	}

	if (source.type === "url") {
		const url = yield* normalizeHttpUrlParts(source.value);
		return new CapabilitySource({ type: "url", value: url.normalizedValue });
	}

	return new CapabilitySource({ type: "npm", value: normalizeNpmSourceValue(source.value) });
});

/** Build a deterministic source resolution plan without fetching or executing package managers. */
export const planCapabilityResolution = Effect.fn("CapabilitySource.planResolution")(function* (
	targetDir: string,
	source: CapabilitySource,
	rawId?: string,
) {
	const path = yield* Path.Path;
	const normalizedSource = yield* normalizeCapabilitySource(targetDir, source).pipe(
		Effect.provideService(Path.Path, path),
	);
	const name = yield* defaultCapabilityName(normalizedSource).pipe(Effect.provideService(Path.Path, path));
	const id = rawId ?? makeCapabilityId(normalizedSource.type, name);
	const slug = makeCapabilitySlug(id);
	const cacheSlug = makeCapabilityCacheSlug(normalizedSource);

	if (normalizedSource.type === "local") {
		const root = normalizedSource.value;
		return new CapabilityResolutionPlan({
			source,
			normalizedSource,
			id,
			slug,
			cacheSlug,
			requiresFetch: false,
			local: new CapabilityLocalResolution({
				root,
				manifestPath: path.join(root, CAPABILITY_MANIFEST_NAME),
			}),
			remote: null,
		});
	}

	if (normalizedSource.type === "git") {
		const git = normalizeGitParts(normalizedSource.value);
		return new CapabilityResolutionPlan({
			source,
			normalizedSource,
			id,
			slug,
			cacheSlug,
			requiresFetch: true,
			local: null,
			remote: new CapabilityRemoteFetch({ type: "git", locator: git.locator, ref: git.ref }),
		});
	}

	if (normalizedSource.type === "url") {
		const url = yield* normalizeHttpUrlParts(normalizedSource.value);
		const fetchType = urlFetchType(url.pathname);
		return new CapabilityResolutionPlan({
			source,
			normalizedSource,
			id,
			slug,
			cacheSlug,
			requiresFetch: true,
			local: null,
			remote: new CapabilityRemoteFetch({
				type: fetchType,
				locator: url.locator,
				ref: url.ref,
				urlKind: fetchType === "url-manifest" ? "manifest" : "archive",
			}),
		});
	}

	const npm = parseNpmPackageSpec(normalizedSource.value);
	return new CapabilityResolutionPlan({
		source,
		normalizedSource,
		id,
		slug,
		cacheSlug,
		requiresFetch: true,
		local: null,
		remote: new CapabilityRemoteFetch({
			type: "npm",
			locator: normalizedSource.value,
			ref: null,
			packageName: npm.packageName,
			...(npm.packageSpec === null ? {} : { packageSpec: npm.packageSpec }),
		}),
	});
});

/** Parse and plan a raw user source in one deterministic, side-effect-free step. */
export const parseAndPlanCapabilitySource = Effect.fn("CapabilitySource.parseAndPlan")(function* (
	targetDir: string,
	rawSource: string,
	rawId?: string,
) {
	const source = yield* parseCapabilitySource(rawSource);
	return yield* planCapabilityResolution(targetDir, source, rawId);
});
