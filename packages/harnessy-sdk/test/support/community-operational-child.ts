import { readFileSync } from "node:fs";
import { Effect, Exit } from "effect";
import { readCommunityOperation } from "../../../harnessy-core/src/jarvis/community-briefing/operational-input.ts";
import {
	CommunityOperationSystemReference,
	runAuthorizedCommunityBriefing,
} from "../../../harnessy-core/src/jarvis/community-briefing/operational-runtime.ts";
import type {
	MeetingPublicationSmokeRuntimeInput,
	MeetingPublicationSmokeRuntimeObservation,
} from "../../../harnessy-core/src/jarvis/meeting-publication/operational-input.ts";
import { MeetingPublicationSmokeRuntimeSystemReference } from "../../../harnessy-core/src/jarvis/meeting-publication/operational-runtime.ts";
import { runNativeCommunityBriefing } from "../../src/community-briefing/runtime.ts";

const path = process.argv[2];
if (!path || !process.send) throw new Error("operational child requires fixture IPC");
const config = JSON.parse(readFileSync(path, "utf8")) as {
	input: MeetingPublicationSmokeRuntimeInput;
	observation: Omit<MeetingPublicationSmokeRuntimeObservation, "uid" | "monotonic"> & {
		uid: string;
		monotonic: string;
	};
	paths: { core: string; host: string; sdk: string; dependencies: string };
	pause: boolean;
};
const observation = {
	...config.observation,
	uid: BigInt(config.observation.uid),
	monotonic: BigInt(config.observation.monotonic),
};
// A losing child must independently pass signature/snapshot validation; failure
// before this message cannot satisfy the singleton regression.
readCommunityOperation(config.input, observation);
process.send({ stage: "validated" });
const resume = new Promise<void>((resolve) =>
	process.once("message", (message) => {
		if (message !== "resume") throw new Error("unexpected child message");
		resolve();
	}),
);
const result = await Effect.runPromiseExit(
	runAuthorizedCommunityBriefing(config.input, {
		artifactAnchors: { host: config.paths.host, sdk: config.paths.sdk, dependencies: config.paths.dependencies },
		publish: (grant) =>
			Effect.gen(function* () {
				process.send?.({ stage: "owner" });
				if (config.pause) yield* Effect.tryPromise(() => resume);
				return yield* runNativeCommunityBriefing(grant);
			}),
	}).pipe(
		Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, {
			observe: () => observation,
			proveNoKnownV1Writers: () => {
				throw new Error("wrong workflow probe");
			},
		}),
		Effect.provideService(CommunityOperationSystemReference, {
			coreAnchor: config.paths.core,
			proveCompatibilityAbsent: () => {},
		}),
	),
);
process.send({ stage: "finished", success: Exit.isSuccess(result) });
process.disconnect();
