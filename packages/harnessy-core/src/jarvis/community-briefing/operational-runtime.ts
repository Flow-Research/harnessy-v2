import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Context, Effect, Schema } from "effect";
import {
	artifactInventorySteps,
	type MeetingPublicationSmokeRuntimeInput,
} from "../meeting-publication/operational-input.ts";
import { MeetingPublicationSmokeRuntimeSystemReference } from "../meeting-publication/operational-runtime.ts";
import type { CommunityBriefingWriteGrant } from "./authority.ts";
import { CommunityBriefingGrantHost } from "./grant-host.ts";
import { readCommunityOperation } from "./operational-input.ts";

const labels = [
	"tech.flowresearch.jarvis.meeting-review",
	"tech.flowresearch.jarvis.briefing-review",
	"com.flow-harness.community-review-v2",
	"com.flow-harness.project.weekly-community-briefing-generate",
	"com.flow-harness.project.weekly-community-briefing-worker",
];
const command = (path: string, args: ReadonlyArray<string>) => {
	const executable = realpathSync(path),
		stat = lstatSync(executable);
	if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("unsafe_probe");
	const result = spawnSync(executable, args, { encoding: "utf8", shell: false, timeout: 2000, maxBuffer: 1_000_000 });
	if (result.error || result.signal) throw new Error("probe_failed");
	return result;
};
/** Bounded known-process evidence, not protection from arbitrary same-UID code. */
const proveCompatibilityAbsent = () => {
	const uid = process.geteuid?.();
	if (uid === undefined) throw new Error("unsupported_platform");
	const processes = command("/bin/ps", ["-axo", "uid=,pid=,command="]);
	if (processes.status !== 0) throw new Error("probe_failed");
	for (const line of processes.stdout.split("\n")) {
		if (!line.trim()) continue;
		const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
		if (!match) throw new Error("probe_failed");
		if (Number(match[1]) !== uid || Number(match[2]) === process.pid) continue;
		if (
			match[3].includes("jarvis meeting publish review serve") ||
			match[3].includes("jarvis meeting review serve") ||
			/(?:jarvis|harnessy|hsy)(?:\s+|.*\/)(?:community\s+briefing|community-briefing)|briefing[-_]review|briefing[-_]worker/u.test(
				match[3],
			)
		)
			throw new Error("compatibility_writer_present");
	}
	if (process.platform === "darwin") {
		for (const label of labels) {
			const result = command("/bin/launchctl", ["print", `gui/${uid}/${label}`]);
			if (result.status === 0 || !`${result.stdout}\n${result.stderr}`.includes("Could not find service"))
				throw new Error("compatibility_writer_present");
		}
	} else if (process.platform === "linux") {
		const result = command("/usr/bin/crontab", ["-l"]);
		if (result.status !== 0 && !/no crontab for/iu.test(result.stderr)) throw new Error("probe_failed");
		if (/community[- ]briefing|briefing[-_]review/u.test(result.stdout))
			throw new Error("compatibility_writer_present");
	} else throw new Error("unsupported_platform");
};

/** Source-private fixture seam; no observer, bypass or signing key is accepted by the CLI. */
export const CommunityOperationSystemReference = Context.Reference<{
	readonly proveCompatibilityAbsent: () => void;
	readonly coreAnchor: string;
}>("@harnessy/core/CommunityOperationSystem", {
	defaultValue: () => ({ proveCompatibilityAbsent, coreAnchor: realpathSync(fileURLToPath(import.meta.url)) }),
});

export class CommunityOperationError extends Schema.TaggedErrorClass<CommunityOperationError>()(
	"CommunityOperationError",
	{
		code: Schema.Literals(["invalid_authorization", "runtime_rejected", "publication_uncertain"]),
	},
) {}

export interface CommunityOperationConsumer {
	readonly artifactAnchors: { readonly host: string; readonly sdk: string; readonly dependencies: string };
	readonly publish: (grant: CommunityBriefingWriteGrant) => Effect.Effect<
		{
			readonly briefingId: string;
			readonly googleDocId: string;
			readonly discordMessageId: string;
		},
		unknown
	>;
}

/** One scoped, externally authorized publication; never returns authority or repairs uncertainty. */
export const runAuthorizedCommunityBriefing = (
	input: MeetingPublicationSmokeRuntimeInput,
	consumer: CommunityOperationConsumer,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const observationSystem = yield* MeetingPublicationSmokeRuntimeSystemReference;
			const system = yield* CommunityOperationSystemReference;
			const initial = yield* Effect.try({
				try: () => observationSystem.observe(),
				catch: () => new CommunityOperationError({ code: "runtime_rejected" }),
			});
			const verified = yield* Effect.try({
				try: () => readCommunityOperation(input, initial),
				catch: () => new CommunityOperationError({ code: "invalid_authorization" }),
			});
			const { envelope } = verified;
			for (const [role, path] of Object.entries(consumer.artifactAnchors)) {
				if (!verified.manifest.anchors.some((anchor) => anchor.role === role && anchor.path === path))
					return yield* new CommunityOperationError({ code: "runtime_rejected" });
			}
			let active = true,
				lastWall = initial.now,
				lastMonotonic = initial.monotonic;
			const assertTime = () => {
				const current = observationSystem.observe();
				if (
					!active ||
					!Number.isFinite(current.now) ||
					current.now < lastWall ||
					current.monotonic < lastMonotonic ||
					current.now >= verified.expiry ||
					current.monotonic - initial.monotonic >= BigInt(verified.expiry - initial.now) * 1_000_000n ||
					current.bootId !== initial.bootId ||
					current.uid !== initial.uid ||
					current.hostname !== initial.hostname ||
					current.platform !== initial.platform ||
					current.architecture !== initial.architecture ||
					current.executablePath !== initial.executablePath
				)
					throw new Error("runtime_changed");
				lastWall = current.now;
				lastMonotonic = current.monotonic;
				verified.assertLedger();
				verified.assertMutable();
			};
			const check = () =>
				Effect.tryPromise({
					try: async (signal) => {
						assertTime();
						verified.assertImmutable();
						system.proveCompatibilityAbsent();
						let deadline = performance.now() + 8;
						for (const _step of artifactInventorySteps(
							verified.manifest,
							initial.uid,
							"smoke",
							system.coreAnchor,
						)) {
							signal.throwIfAborted();
							if (performance.now() >= deadline) {
								await yieldToEventLoop(undefined, { signal });
								deadline = performance.now() + 8;
							}
						}
						assertTime();
						system.proveCompatibilityAbsent();
					},
					catch: () => new Error("community_runtime_rejected"),
				});
			yield* check();
			const host = yield* Effect.acquireRelease(
				Effect.try(
					() =>
						new CommunityBriefingGrantHost(
							envelope.statePath,
							verified.keys,
							envelope.queuePath,
							envelope.statePath,
							envelope.providerScope,
							() => observationSystem.observe().now,
						),
				),
				(value) =>
					Effect.sync(() => {
						active = false;
						value.close();
					}),
			);
			const binding = host.bind(envelope, { check, assertLedger: verified.assertLedger });
			const grant = yield* binding.authorize();
			const monitor = Effect.forever(
				Effect.andThen(
					Effect.sleep("250 millis"),
					Effect.andThen(Effect.try(assertTime), binding.revalidate(grant)),
				),
			);
			// On interruption/failure the durable lease and consumed nonce remain.
			// Only confirmed completion releases this process's exact lease.
			const result = yield* consumer.publish(grant).pipe(
				Effect.raceFirst(monitor),
				Effect.mapError(() => new CommunityOperationError({ code: "publication_uncertain" })),
			);
			if (result.briefingId !== envelope.briefingId || !result.googleDocId || !result.discordMessageId)
				return yield* new CommunityOperationError({ code: "publication_uncertain" });
			yield* Effect.try(() => binding.complete());
			return { kind: "harnessy.community.briefing.publication-result" as const, status: "published" as const };
		}),
	).pipe(
		Effect.mapError((cause) =>
			cause instanceof CommunityOperationError ? cause : new CommunityOperationError({ code: "runtime_rejected" }),
		),
	);
