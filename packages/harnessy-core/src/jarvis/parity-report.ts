import { fileURLToPath } from "node:url";

import { FileSystem, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";
import {
	JarvisParityEntry,
	JarvisParitySummary,
	type JarvisParityValidationError,
	parseJarvisCommandManifest,
	parseJarvisParityManifest,
	parseJarvisStateManifest,
	summarizeJarvisParity,
	validateJarvisParity,
} from "./parity.ts";

export class JarvisParityReport extends Schema.Class<JarvisParityReport>("JarvisParityReport")({
	sourceVersion: Schema.String,
	summary: JarvisParitySummary,
	entries: Schema.Array(JarvisParityEntry),
}) {}

const fixtureRoot = fileURLToPath(new URL("../../fixtures/jarvis-v1/", import.meta.url));

/** Loads and validates the checked-in compatibility ledger without mutating project or user state. */
export class JarvisParityReporter extends Context.Service<
	JarvisParityReporter,
	{
		readonly inspect: () => Effect.Effect<JarvisParityReport, HarnessError | JarvisParityValidationError>;
	}
>()("@harnessy/core/JarvisParityReporter") {
	static readonly layer = Layer.effect(
		JarvisParityReporter,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const readFixture = Effect.fn("JarvisParityReporter.readFixture")(function* (name: string) {
				const path = `${fixtureRoot}${name}`;
				return yield* fs.readFileString(path).pipe(
					Effect.mapError(
						(cause) =>
							new HarnessError({
								message: `Could not read Jarvis fixture ${path}: ${causeMessage(cause)}`,
								cause,
							}),
					),
				);
			});

			const inspect = Effect.fn("JarvisParityReporter.inspect")(function* () {
				const [commandRaw, stateRaw, parityRaw] = yield* Effect.all([
					readFixture("command-manifest.json"),
					readFixture("state-manifest.json"),
					readFixture("parity-manifest.json"),
				]);
				const [commands, state, parity] = yield* Effect.all([
					parseJarvisCommandManifest(commandRaw, "command-manifest.json"),
					parseJarvisStateManifest(stateRaw, "state-manifest.json"),
					parseJarvisParityManifest(parityRaw, "parity-manifest.json"),
				]);
				yield* validateJarvisParity(parity, commands, state);
				return new JarvisParityReport({
					sourceVersion: parity.sourceVersion,
					summary: yield* summarizeJarvisParity(parity),
					entries: parity.entries,
				});
			});

			return { inspect };
		}),
	);
}
