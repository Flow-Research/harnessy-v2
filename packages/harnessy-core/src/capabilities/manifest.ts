import { Schema } from "effect";
import * as Effect from "effect/Effect";

import { causeMessage, HarnessError } from "../errors.ts";

/** Kinds of dependency declarations a capability can request. */
export const DependencyKind = Schema.Literals(["tool", "node", "python"]);

/** Kinds of dependency declarations a capability can request. */
export type DependencyKind = typeof DependencyKind.Type;

/** One dependency declaration from a capability manifest. */
export class DependencyRequirement extends Schema.Class<DependencyRequirement>("DependencyRequirement")({
	/** Dependency family. Tool dependencies are checked via PATH; node/python package checks are planned. */
	kind: DependencyKind,
	/** Human-readable dependency name. */
	name: Schema.String,
	/** Optional command/executable name for `tool` dependencies. Defaults to `name`. */
	command: Schema.optional(Schema.String),
	/** Whether missing dependency should fail verification. Defaults to true. */
	required: Schema.optional(Schema.Boolean),
	/** Platform-specific install hints such as `linux`, `darwin`, or `fallback`. */
	install: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

/** Coarse blast radius metadata for capability review and future Garden policy controls. */
export const BlastRadius = Schema.Literals(["none", "low", "medium", "high", "critical"]);

/** Coarse blast radius metadata for capability review and future Garden policy controls. */
export type BlastRadius = typeof BlastRadius.Type;

const isCapabilityRelativePath = (value: string): boolean => {
	const normalized = value.replaceAll("\\", "/");
	if (normalized.startsWith("/") || normalized.startsWith("~/")) return false;
	if (/^[A-Za-z]:/.test(normalized)) return false;
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized)) return false;
	const segments = normalized.split("/");
	return (
		segments.every((segment) => segment !== "" && segment !== "..") && segments.some((segment) => segment !== ".")
	);
};

/** Relative path inside a capability package; it cannot be absolute or escape the package root. */
export const CapabilityRelativePath = Schema.NonEmptyString.check(
	Schema.makeFilter((value: string) =>
		isCapabilityRelativePath(value)
			? undefined
			: "path must be relative to the capability root and must not include parent-directory segments",
	),
);

/** Relative path inside a capability package; it cannot be absolute or escape the package root. */
export type CapabilityRelativePath = typeof CapabilityRelativePath.Type;

/** Kinds of resources a native Harnessy capability manifest can declare. */
export const CapabilityResourceKind = Schema.Literals([
	"context",
	"skill",
	"command",
	"prompt",
	"template",
	"tool",
	"extension",
	"script",
	"reference",
]);

/** Kinds of resources a native Harnessy capability manifest can declare. */
export type CapabilityResourceKind = typeof CapabilityResourceKind.Type;

/** A file, directory, or reference contributed by a capability package. */
export class CapabilityResource extends Schema.Class<CapabilityResource>("CapabilityResource")({
	/** Resource family. */
	kind: CapabilityResourceKind,
	/** Capability-root-relative path to the resource source. */
	path: CapabilityRelativePath,
	/** Optional capability-root-relative materialization target for a later installer. */
	target: Schema.optional(CapabilityRelativePath),
	/** Optional human-readable resource description. */
	description: Schema.optional(Schema.String),
	/** Whether this resource should be executable after materialization. */
	executable: Schema.optional(Schema.Boolean),
}) {}

/** Deterministic check kind for a path that must exist under the capability root. */
export class PathExistsCheck extends Schema.Class<PathExistsCheck>("PathExistsCheck")({
	/** Stable check id within the capability manifest. */
	id: Schema.NonEmptyString,
	/** Deterministic check family. */
	kind: Schema.Literal("path-exists"),
	/** Optional human-readable check description. */
	description: Schema.optional(Schema.String),
	/** Whether a failing check should fail verification. Defaults to true for later runners. */
	required: Schema.optional(Schema.Boolean),
	/** Capability-root-relative path that must exist. */
	path: CapabilityRelativePath,
}) {}

/** Deterministic check kind for asserting expected text in a capability file. */
export class FileContainsCheck extends Schema.Class<FileContainsCheck>("FileContainsCheck")({
	/** Stable check id within the capability manifest. */
	id: Schema.NonEmptyString,
	/** Deterministic check family. */
	kind: Schema.Literal("file-contains"),
	/** Optional human-readable check description. */
	description: Schema.optional(Schema.String),
	/** Whether a failing check should fail verification. Defaults to true for later runners. */
	required: Schema.optional(Schema.Boolean),
	/** Capability-root-relative file path to inspect. */
	path: CapabilityRelativePath,
	/** Text that must be present in the file. */
	contains: Schema.NonEmptyString,
}) {}

/** Deterministic check kind for asserting that a tool is available on PATH. */
export class ToolAvailableCheck extends Schema.Class<ToolAvailableCheck>("ToolAvailableCheck")({
	/** Stable check id within the capability manifest. */
	id: Schema.NonEmptyString,
	/** Deterministic check family. */
	kind: Schema.Literal("tool-available"),
	/** Optional human-readable check description. */
	description: Schema.optional(Schema.String),
	/** Whether a failing check should fail verification. Defaults to true for later runners. */
	required: Schema.optional(Schema.Boolean),
	/** Executable name a later runner should resolve on PATH. */
	command: Schema.NonEmptyString,
}) {}

/** Deterministic capability check declaration for later verification runners. */
export const CapabilityCheck = Schema.Union([PathExistsCheck, FileContainsCheck, ToolAvailableCheck]);

/** Deterministic capability check declaration for later verification runners. */
export type CapabilityCheck = typeof CapabilityCheck.Type;

/** Invocation hint metadata for a later Harnessy runtime. */
export class CapabilityInvokeMetadata extends Schema.Class<CapabilityInvokeMetadata>("CapabilityInvokeMetadata")({
	/** Optional executable or command name to invoke. */
	command: Schema.optional(Schema.NonEmptyString),
	/** Optional argument list documented for the runtime. */
	args: Schema.optional(Schema.Array(Schema.String)),
	/** Optional human-readable invocation description. */
	description: Schema.optional(Schema.String),
}) {}

/** Invocation metadata can be a simple command string or structured runtime hint. */
export const CapabilityInvoke = Schema.Union([Schema.NonEmptyString, CapabilityInvokeMetadata]);

/** Invocation metadata can be a simple command string or structured runtime hint. */
export type CapabilityInvoke = typeof CapabilityInvoke.Type;

/** Durable state declaration exposed by a capability package. */
export class CapabilityStateDeclaration extends Schema.Class<CapabilityStateDeclaration>("CapabilityStateDeclaration")({
	/** Stable state id within the capability manifest. */
	id: Schema.NonEmptyString,
	/** Optional capability-root-relative state source path. */
	path: Schema.optional(CapabilityRelativePath),
	/** Optional capability-root-relative state materialization target. */
	target: Schema.optional(CapabilityRelativePath),
	/** Optional human-readable state description. */
	description: Schema.optional(Schema.String),
	/** Optional state scope label for a later runtime. */
	scope: Schema.optional(Schema.String),
}) {}

/** Trace artifact declaration exposed by a capability package. */
export class CapabilityTraceDeclaration extends Schema.Class<CapabilityTraceDeclaration>("CapabilityTraceDeclaration")({
	/** Stable trace id within the capability manifest. */
	id: Schema.NonEmptyString,
	/** Optional capability-root-relative trace artifact path. */
	path: Schema.optional(CapabilityRelativePath),
	/** Optional human-readable trace description. */
	description: Schema.optional(Schema.String),
}) {}

/** Autoresearch metadata declared by a capability package. */
export class CapabilityAutoresearchMetadata extends Schema.Class<CapabilityAutoresearchMetadata>(
	"CapabilityAutoresearchMetadata",
)({
	/** Whether autoresearch is enabled for a later runtime. */
	enabled: Schema.optional(Schema.Boolean),
	/** Optional human-readable autoresearch description. */
	description: Schema.optional(Schema.String),
	/** Optional seed queries for a later autoresearch runner. */
	queries: Schema.optional(Schema.Array(Schema.NonEmptyString)),
}) {}

/** Metadata declared by a capability package for zero-effort installation. */
export class CapabilityManifest extends Schema.Class<CapabilityManifest>("CapabilityManifest")({
	/** Stable capability id, usually namespaced like `local:my-capability` or `npm:pkg-name`. */
	id: Schema.String,
	/** Human-readable capability name. */
	name: Schema.String,
	/** Optional capability type label for grouping and review. */
	type: Schema.optional(Schema.String),
	/** Optional semantic version supplied by the capability package. */
	version: Schema.optional(Schema.String),
	/** Optional short description for humans and agents. */
	description: Schema.optional(Schema.String),
	/** Context files contributed by this capability, relative to the capability root. */
	context: Schema.optional(Schema.Array(Schema.String)),
	/** First-class resources contributed by this capability. */
	resources: Schema.optional(Schema.Array(CapabilityResource)),
	/** Deterministic checks declared by this capability for a later runner. */
	checks: Schema.optional(Schema.Array(CapabilityCheck)),
	/** External tools or packages required by this capability. */
	dependencies: Schema.optional(Schema.Array(DependencyRequirement)),
	/** Coarse risk level for human review and future policy gates. */
	blastRadius: Schema.optional(BlastRadius),
	/** Permission labels requested by the capability. */
	permissions: Schema.optional(Schema.Array(Schema.String)),
	/** Data category labels the capability may read or write. */
	dataCategories: Schema.optional(Schema.Array(Schema.String)),
	/** Network egress destinations or destination classes the capability may contact. */
	egress: Schema.optional(Schema.Array(Schema.String)),
	/** Optional owner or responsible team metadata. */
	owner: Schema.optional(Schema.String),
	/** Optional lifecycle status metadata. */
	status: Schema.optional(Schema.String),
	/** Optional install scope metadata such as project, user, workspace, or organization. */
	installScope: Schema.optional(Schema.String),
	/** Optional invocation hint for a later Harnessy runtime. */
	invoke: Schema.optional(CapabilityInvoke),
	/** Optional durable state declarations for a later Harnessy runtime. */
	state: Schema.optional(Schema.Array(CapabilityStateDeclaration)),
	/** Optional trace artifact declarations for audit and review. */
	traces: Schema.optional(Schema.Array(CapabilityTraceDeclaration)),
	/** Optional autoresearch metadata for a later Harnessy runtime. */
	autoresearch: Schema.optional(CapabilityAutoresearchMetadata),
}) {}

/** File name Harnessy looks for at a local capability source root. */
export const CAPABILITY_MANIFEST_NAME = "harnessy.capability.json";

/** Decode local capability manifests from JSON text. */
const CapabilityManifestJson = Schema.fromJsonString(CapabilityManifest);

/** Parse and validate a capability manifest as an Effect. */
export const parseCapabilityManifest = Effect.fn("CapabilityManifest.parse")(function* (
	raw: string,
	sourcePath: string,
) {
	return yield* Schema.decodeUnknownEffect(CapabilityManifestJson)(raw).pipe(
		Effect.mapError(
			(cause) =>
				new HarnessError({
					message: `Invalid Harnessy capability manifest ${sourcePath}: ${causeMessage(cause)}`,
					cause,
				}),
		),
	);
});
