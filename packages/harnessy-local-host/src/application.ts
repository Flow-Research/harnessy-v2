import {
	type JarvisMeetingPublicationConfig,
	MeetingPublicationInspector,
} from "@harnessy/core/meeting-publication-inspector";
import * as Effect from "effect/Effect";
import { readLocalHostArtifactDigest, readLocalHostConfig, validateLocalHostBindings } from "./input.ts";
import type { LocalHostSchedulerPlanInput } from "./schema.ts";
import {
	inactiveOperationalGates,
	LocalHostBinding,
	LocalHostInspectionEvidence,
	LocalHostOwnershipPlan,
	LocalHostPlanReceipt,
	LocalHostPreflightCheckEvidence,
	LocalHostPreflightEvidence,
	LocalHostReviewTokenPlan,
	LocalHostScanEvidence,
	LocalHostStateEvidence,
	makeInactiveSchedulerPlans,
	makePlanEnvelope,
} from "./schema.ts";

export class LocalHostApplicationError extends Error {
	readonly code: "invalid_time" | "missing_binding" | "unexpected_authority";

	constructor(code: LocalHostApplicationError["code"]) {
		super("Local-host read-only operation failed");
		this.name = "LocalHostApplicationError";
		this.code = code;
	}
}

export interface LocalHostReadOnlyInput {
	readonly config: JarvisMeetingPublicationConfig;
	readonly nowMillis: number;
	readonly sinceDays?: number;
}

export interface LocalHostExportInput extends LocalHostSchedulerPlanInput {
	readonly nowMillis: number;
	readonly sinceDays?: number;
}

const assertTimeInput = (nowMillis: number, sinceDays: number | undefined) => {
	if (!Number.isSafeInteger(nowMillis) || nowMillis < 0) throw new LocalHostApplicationError("invalid_time");
	if (sinceDays !== undefined && (!Number.isSafeInteger(sinceDays) || sinceDays < 1 || sinceDays > 365)) {
		throw new LocalHostApplicationError("invalid_time");
	}
};

const inspectorLayer = (config: JarvisMeetingPublicationConfig) => {
	validateLocalHostBindings(config);
	return MeetingPublicationInspector.readOnlyV1OwnedLayer(config);
};

export const readLocalHostStatus = async (input: LocalHostReadOnlyInput) => {
	assertTimeInput(input.nowMillis, input.sinceDays);
	return Effect.runPromise(
		Effect.gen(function* () {
			const inspector = yield* MeetingPublicationInspector;
			const authority = yield* inspector.authority();
			const state = yield* inspector.inspectState();
			return {
				kind: "harnessy.local-host.status" as const,
				activated: false as const,
				activationReady: false as const,
				writeAllowed: false as const,
				authority,
				state,
			};
		}).pipe(Effect.provide(inspectorLayer(input.config))),
	);
};

export const inspectLocalHost = async (input: LocalHostReadOnlyInput) => {
	assertTimeInput(input.nowMillis, input.sinceDays);
	return Effect.runPromise(
		Effect.gen(function* () {
			const inspector = yield* MeetingPublicationInspector;
			const authority = yield* inspector.authority();
			const validation = yield* inspector.validate();
			const state = yield* inspector.inspectState();
			return {
				kind: "harnessy.local-host.inspection" as const,
				activated: false as const,
				activationReady: false as const,
				writeAllowed: false as const,
				authority,
				validation,
				state,
			};
		}).pipe(Effect.provide(inspectorLayer(input.config))),
	);
};

export const scanLocalHostDry = async (input: LocalHostReadOnlyInput) => {
	assertTimeInput(input.nowMillis, input.sinceDays);
	return Effect.runPromise(
		Effect.gen(function* () {
			const inspector = yield* MeetingPublicationInspector;
			return yield* inspector.scanDry(input.nowMillis, input.sinceDays);
		}).pipe(Effect.provide(inspectorLayer(input.config))),
	);
};

export const preflightLocalHostOffline = async (input: LocalHostReadOnlyInput) => {
	assertTimeInput(input.nowMillis, input.sinceDays);
	return Effect.runPromise(
		Effect.gen(function* () {
			const inspector = yield* MeetingPublicationInspector;
			return yield* inspector.offlinePreflight(input.nowMillis, input.sinceDays);
		}).pipe(Effect.provide(inspectorLayer(input.config))),
	);
};

export const exportLocalHostPlan = async (input: LocalHostExportInput) => {
	assertTimeInput(input.nowMillis, input.sinceDays);
	const loaded = readLocalHostConfig(input.configPath);
	const executable = readLocalHostArtifactDigest(input.hostExecutable);
	if (loaded.config.sourcePath === null || loaded.config.statePath === null) {
		throw new LocalHostApplicationError("missing_binding");
	}
	const evidence = await Effect.runPromise(
		Effect.gen(function* () {
			const inspector = yield* MeetingPublicationInspector;
			const scan = yield* inspector.scanDry(input.nowMillis, input.sinceDays);
			const state = yield* inspector.inspectState();
			const preflight = yield* inspector.offlinePreflight(input.nowMillis, input.sinceDays);
			return { scan, state, preflight };
		}).pipe(Effect.provide(inspectorLayer(loaded.config))),
	);
	if (evidence.preflight.ready) throw new LocalHostApplicationError("unexpected_authority");

	const receipt = new LocalHostPlanReceipt({
		kind: "harnessy.local-host.meeting-publication.plan",
		schemaVersion: 1,
		createdAt: new Date(input.nowMillis).toISOString(),
		activated: false,
		activationReady: false,
		binding: new LocalHostBinding({
			configPath: loaded.path,
			sourcePath: loaded.config.sourcePath,
			statePath: loaded.config.statePath,
			configSha256: loaded.sha256,
			hostExecutablePath: executable.path,
			hostExecutableSha256: executable.sha256,
		}),
		ownership: new LocalHostOwnershipPlan({ currentWriter: "v1", plannedWriter: "v2", writeAllowed: false }),
		reviewToken: new LocalHostReviewTokenPlan({
			included: false,
			disposition: "regenerate_after_activation_review",
		}),
		inspection: new LocalHostInspectionEvidence({
			state: new LocalHostStateEvidence({
				exists: evidence.state.exists,
				schemaState: evidence.state.schemaState,
				schemaVersion: evidence.state.schemaVersion,
				totalItems: evidence.state.totalItems,
				statusCounts: evidence.state.statusCounts,
				failureCounts: evidence.state.failureCounts,
			}),
			scan: new LocalHostScanEvidence({
				filesSeen: evidence.scan.filesSeen,
				eligible: evidence.scan.eligible,
				exclusions: evidence.scan.exclusions,
				dryRun: true,
			}),
			preflight: new LocalHostPreflightEvidence({
				ready: false,
				checks: evidence.preflight.checks.map(
					(check) =>
						new LocalHostPreflightCheckEvidence({
							name: check.name,
							passed: check.passed,
							required: check.required,
							code: check.code,
						}),
				),
			}),
		}),
		operationalGates: inactiveOperationalGates(),
		schedulers: makeInactiveSchedulerPlans(input),
	});
	return makePlanEnvelope(receipt);
};
