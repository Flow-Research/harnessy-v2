import { Schema } from "effect";
import * as Effect from "effect/Effect";

import { causeMessage, HarnessError } from "../errors.ts";
import { JARVIS_CONTEXT_FILES } from "./context.ts";

export const JarvisParityStatus = Schema.Literals(["missing", "partial", "compatible", "intentionally-retired"]);
export type JarvisParityStatus = typeof JarvisParityStatus.Type;

export const JarvisProtocolSurface = Schema.Literals([
	"command",
	"state",
	"context",
	"connector",
	"workflow",
	"channel",
	"host-capability",
]);
export type JarvisProtocolSurface = typeof JarvisProtocolSurface.Type;

/** One auditable compatibility decision in the Jarvis protocol parity ledger. */
export class JarvisParityEntry extends Schema.Class<JarvisParityEntry>("JarvisParityEntry")({
	id: Schema.String,
	surface: JarvisProtocolSurface,
	legacyReference: Schema.String,
	status: JarvisParityStatus,
	replacement: Schema.optional(Schema.String),
	rationale: Schema.optional(Schema.String),
}) {}

/** Versioned parity ledger generated from the frozen Python compatibility oracle. */
export class JarvisParityManifest extends Schema.Class<JarvisParityManifest>("JarvisParityManifest")({
	schemaVersion: Schema.Literal(1),
	sourceVersion: Schema.String,
	entries: Schema.Array(JarvisParityEntry),
}) {}

export class JarvisParityValidationError extends Schema.TaggedErrorClass<JarvisParityValidationError>()(
	"JarvisParityValidationError",
	{
		issues: Schema.Array(Schema.String),
	},
) {}

export class JarvisParityCounts extends Schema.Class<JarvisParityCounts>("JarvisParityCounts")({
	total: Schema.Int,
	missing: Schema.Int,
	partial: Schema.Int,
	compatible: Schema.Int,
	intentionallyRetired: Schema.Int,
}) {}

export class JarvisParitySurfaceSummary extends Schema.Class<JarvisParitySurfaceSummary>("JarvisParitySurfaceSummary")({
	surface: JarvisProtocolSurface,
	counts: JarvisParityCounts,
}) {}

export class JarvisParitySummary extends Schema.Class<JarvisParitySummary>("JarvisParitySummary")({
	counts: JarvisParityCounts,
	surfaces: Schema.Array(JarvisParitySurfaceSummary),
}) {}

export class JarvisCommandArgument extends Schema.Class<JarvisCommandArgument>("JarvisCommandArgument")({
	name: Schema.String,
	type: Schema.String,
	required: Schema.Boolean,
	nargs: Schema.Number,
	default: Schema.Unknown,
}) {}

export class JarvisCommandOption extends Schema.Class<JarvisCommandOption>("JarvisCommandOption")({
	names: Schema.Array(Schema.String),
	type: Schema.String,
	required: Schema.Boolean,
	multiple: Schema.Boolean,
	count: Schema.Boolean,
	default: Schema.Unknown,
	choices: Schema.optional(Schema.Array(Schema.Unknown)),
}) {}

export class JarvisCommandEntry extends Schema.Class<JarvisCommandEntry>("JarvisCommandEntry")({
	path: Schema.Array(Schema.String),
	kind: Schema.Literals(["group", "command"]),
	semanticName: Schema.String,
	alias: Schema.Boolean,
	help: Schema.String,
	arguments: Schema.Array(JarvisCommandArgument),
	options: Schema.Array(JarvisCommandOption),
}) {}

export class JarvisCommandManifest extends Schema.Class<JarvisCommandManifest>("JarvisCommandManifest")({
	schemaVersion: Schema.Literal(1),
	source: Schema.Struct({
		kind: Schema.Literal("jarvis-click"),
		version: Schema.String,
		path: Schema.String,
		pythonSourceSha256: Schema.String,
	}),
	generatedBy: Schema.String,
	normalization: Schema.Record(Schema.String, Schema.Unknown),
	commands: Schema.Array(JarvisCommandEntry),
}) {}

export const JarvisStateFormat = Schema.Literals([
	"yaml",
	"json",
	"text",
	"markdown",
	"json-directory",
	"yaml-markdown-json-directory",
	"markdown-directory",
	"json-markdown-directory",
]);
export const JarvisMissingBehavior = Schema.Literals(["defaults", "empty", "none", "global-fallback"]);
export const JarvisMalformedBehavior = Schema.Literals([
	"error",
	"empty",
	"not-applicable",
	"skip-entry",
	"quarantine-or-skip",
]);

export class JarvisStateStoreManifest extends Schema.Class<JarvisStateStoreManifest>("JarvisStateStoreManifest")({
	id: Schema.String,
	pathTemplate: Schema.String,
	format: JarvisStateFormat,
	missingBehavior: JarvisMissingBehavior,
	malformedBehavior: JarvisMalformedBehavior,
	fixture: Schema.optional(Schema.String),
	malformedFixture: Schema.optional(Schema.String),
	source: Schema.String,
}) {}

export class JarvisStateManifest extends Schema.Class<JarvisStateManifest>("JarvisStateManifest")({
	schemaVersion: Schema.Literal(1),
	stores: Schema.Array(JarvisStateStoreManifest),
}) {}

export class JarvisStateFixtureValidation extends Schema.Class<JarvisStateFixtureValidation>(
	"JarvisStateFixtureValidation",
)({
	storeId: Schema.String,
	kind: Schema.Literals(["valid", "malformed"]),
	fixture: Schema.String,
	sha256: Schema.String,
	validator: Schema.String,
}) {}

export class JarvisStateFixtureOracle extends Schema.Class<JarvisStateFixtureOracle>("JarvisStateFixtureOracle")({
	schemaVersion: Schema.Literal(1),
	pythonSourceSha256: Schema.String,
	stateManifestSha256: Schema.String,
	validations: Schema.Array(JarvisStateFixtureValidation),
}) {}

export class JarvisAdapterErrorOracle extends Schema.Class<JarvisAdapterErrorOracle>("JarvisAdapterErrorOracle")({
	type: Schema.String,
	base: Schema.String,
	message: Schema.String,
	backend: Schema.NullOr(Schema.String),
	rendered: Schema.String,
	retryableByDefault: Schema.Boolean,
	fields: Schema.Record(Schema.String, Schema.Unknown),
}) {}

export class JarvisRetryDelayOracle extends Schema.Class<JarvisRetryDelayOracle>("JarvisRetryDelayOracle")({
	errorType: Schema.String,
	attempt: Schema.Int,
	retryAfterSeconds: Schema.optional(Schema.Number),
	delaySeconds: Schema.Number,
}) {}

export class JarvisRetryExecutionOracle extends Schema.Class<JarvisRetryExecutionOracle>("JarvisRetryExecutionOracle")({
	case: Schema.String,
	calls: Schema.Int,
	sleeps: Schema.Array(Schema.Number),
	terminalError: Schema.NullOr(Schema.String),
}) {}

export class JarvisAdapterOracle extends Schema.Class<JarvisAdapterOracle>("JarvisAdapterOracle")({
	schemaVersion: Schema.Literal(1),
	source: Schema.Struct({
		path: Schema.String,
		pythonSourceSha256: Schema.String,
	}),
	capabilityKeys: Schema.Array(Schema.String),
	missingCapabilityDefault: Schema.Boolean,
	capabilities: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Boolean)),
	errors: Schema.Array(JarvisAdapterErrorOracle),
	retryPolicy: Schema.Struct({
		maxAttempts: Schema.Int,
		baseDelaySeconds: Schema.Number,
		maxDelaySeconds: Schema.Number,
		exponentialBase: Schema.Number,
		retryableErrors: Schema.Array(Schema.String),
		nonRetryableErrors: Schema.Array(Schema.String),
		delayCases: Schema.Array(JarvisRetryDelayOracle),
		executionCases: Schema.Array(JarvisRetryExecutionOracle),
	}),
}) {}

const JarvisParityManifestJson = Schema.fromJsonString(JarvisParityManifest);
const JarvisCommandManifestJson = Schema.fromJsonString(JarvisCommandManifest);
const JarvisStateManifestJson = Schema.fromJsonString(JarvisStateManifest);
const JarvisStateFixtureOracleJson = Schema.fromJsonString(JarvisStateFixtureOracle);
const JarvisAdapterOracleJson = Schema.fromJsonString(JarvisAdapterOracle);

const parseManifest = <A, I>(schema: Schema.Codec<A, I, never, never>, label: string) =>
	Effect.fn(label)(function* (raw: string, sourcePath: string) {
		return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
			Effect.mapError(
				(cause) =>
					new HarnessError({
						message: `Invalid Jarvis manifest ${sourcePath}: ${causeMessage(cause)}`,
						cause,
					}),
			),
		);
	});

export const parseJarvisCommandManifest = parseManifest(JarvisCommandManifestJson, "JarvisCommandManifest.parse");
export const parseJarvisStateManifest = parseManifest(JarvisStateManifestJson, "JarvisStateManifest.parse");
export const parseJarvisStateFixtureOracle = parseManifest(
	JarvisStateFixtureOracleJson,
	"JarvisStateFixtureOracle.parse",
);
export const parseJarvisAdapterOracle = parseManifest(JarvisAdapterOracleJson, "JarvisAdapterOracle.parse");

export const parseJarvisParityManifest = Effect.fn("JarvisParityManifest.parse")(function* (
	raw: string,
	sourcePath: string,
) {
	return yield* Schema.decodeUnknownEffect(JarvisParityManifestJson)(raw).pipe(
		Effect.mapError(
			(cause) =>
				new HarnessError({
					message: `Invalid Jarvis parity manifest ${sourcePath}: ${causeMessage(cause)}`,
					cause,
				}),
		),
	);
});

const parityCounts = (entries: ReadonlyArray<JarvisParityEntry>) =>
	new JarvisParityCounts({
		total: entries.length,
		missing: entries.filter((entry) => entry.status === "missing").length,
		partial: entries.filter((entry) => entry.status === "partial").length,
		compatible: entries.filter((entry) => entry.status === "compatible").length,
		intentionallyRetired: entries.filter((entry) => entry.status === "intentionally-retired").length,
	});

export const summarizeJarvisParity = Effect.fn("JarvisParityManifest.summarize")((manifest: JarvisParityManifest) => {
	const surfaces = JarvisProtocolSurface.literals.map(
		(surface) =>
			new JarvisParitySurfaceSummary({
				surface,
				counts: parityCounts(manifest.entries.filter((entry) => entry.surface === surface)),
			}),
	);
	return Effect.succeed(new JarvisParitySummary({ counts: parityCounts(manifest.entries), surfaces }));
});

export const validateJarvisParity = Effect.fn("JarvisParityManifest.validate")(function* (
	manifest: JarvisParityManifest,
	commands: JarvisCommandManifest,
	state: JarvisStateManifest,
) {
	const issues: Array<string> = [];
	const ids = new Set<string>();
	for (const entry of manifest.entries) {
		if (ids.has(entry.id)) issues.push(`Duplicate parity id: ${entry.id}`);
		ids.add(entry.id);
		if (!entry.id.startsWith(`${entry.surface}:`)) {
			issues.push(`Parity id ${entry.id} does not match surface ${entry.surface}`);
		}
		if (
			entry.status === "intentionally-retired" &&
			entry.replacement === undefined &&
			entry.rationale === undefined
		) {
			issues.push(`Retired parity entry ${entry.id} requires a replacement or rationale`);
		}
	}
	const sortedIds = [...ids].sort();
	if (manifest.entries.some((entry, index) => entry.id !== sortedIds[index])) {
		issues.push("Parity entries must be sorted by id");
	}
	if (manifest.sourceVersion !== commands.source.version) {
		issues.push(
			`Parity source version ${manifest.sourceVersion} does not match command oracle ${commands.source.version}`,
		);
	}

	const validateOracleSurface = (
		surface: "command" | "state" | "context",
		expectedEntries: ReadonlyArray<readonly [reference: string, id: string]>,
	) => {
		const expected = new Map(expectedEntries);
		const seen = new Set<string>();
		for (const entry of manifest.entries.filter((candidate) => candidate.surface === surface)) {
			if (seen.has(entry.legacyReference)) {
				issues.push(`Duplicate ${surface} parity reference: ${entry.legacyReference}`);
			}
			seen.add(entry.legacyReference);
			const expectedId = expected.get(entry.legacyReference);
			if (expectedId === undefined) {
				issues.push(`Orphaned ${surface} parity entry: ${entry.legacyReference}`);
			} else if (entry.id !== expectedId) {
				issues.push(`Parity id ${entry.id} must be ${expectedId}`);
			}
		}
		for (const reference of expected.keys()) {
			if (!seen.has(reference)) issues.push(`Missing ${surface} parity entry: ${reference}`);
		}
	};

	validateOracleSurface(
		"command",
		commands.commands.map((entry) => [entry.path.join(" "), `command:${entry.path.join(":")}`] as const),
	);
	validateOracleSurface(
		"state",
		state.stores.map((store) => [store.id, `state:${store.id}`] as const),
	);
	validateOracleSurface(
		"context",
		JARVIS_CONTEXT_FILES.map((file) => [file, `context:${file}`] as const),
	);

	if (issues.length > 0) yield* new JarvisParityValidationError({ issues: issues.sort() });
	return manifest;
});
