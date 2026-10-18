import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Context, Effect, Result, Schema } from "effect";
import {
	artifactInventorySteps,
	type MeetingPublicationSmokeRuntimeInput,
	readStableMeetingPublicationSmokeFile,
	sha256MeetingPublicationSmokeBytes,
} from "../meeting-publication/operational-input.ts";
import { MeetingPublicationSmokeRuntimeSystemReference } from "../meeting-publication/operational-runtime.ts";
import { invokesCommand, launchedPrograms } from "../process-invocation.ts";
import {
	type ProcessProbeRunner,
	retryWhileWriterCheckInconclusive,
	runAllWriterCheckProbes,
	runWriterCheckProbe,
	spawnProcessProbe,
	stderrWriterCheckReporter,
	WriterCheckInconclusiveError,
	type WriterCheckName,
	type WriterCheckReporter,
} from "../writer-check.ts";
import type { CommunityBriefingWriteGrant } from "./authority.ts";
import { CommunityBriefingGrantHost } from "./grant-host.ts";
import {
	prepareCommunityServiceRequest,
	readCommunityOperation,
	readCommunityServiceEnrollment,
} from "./operational-input.ts";

/** @internal The launchd labels whose loaded job blocks community publication. */
export const COMMUNITY_GUARD_LABELS = [
	"tech.flowresearch.jarvis.meeting-review",
	"tech.flowresearch.jarvis.briefing-review",
	"com.flow-harness.community-review-v2",
	"com.flow-harness.project.weekly-community-briefing-generate",
	"com.flow-harness.project.weekly-community-briefing-worker",
] as const;
/** Only a root-owned, non-writable executable may answer a writer probe; anything else is tamper evidence. */
const liveProbeRunner: ProcessProbeRunner = (path, args) => {
	const executable = realpathSync(path),
		stat = lstatSync(executable);
	if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("unsafe_probe");
	return spawnProcessProbe(executable, args);
};

/** @internal Recognize only this installed Core's draft-only review entrypoint.
 * Process text alone is insufficient: the caller also probes its executable.
 * Unknown launch wrappers/options fail closed, rather than guessing at argv.
 */
export const isNativeCommunityReviewProcess = (
	commandLine: string,
	launchExecutable: string,
	processExecutable: string,
	expectedExecutable: string,
	reviewEntry: string,
): boolean => {
	const route = " jarvis community briefing review serve";
	const routeIndex = commandLine.indexOf(route);
	if (routeIndex < 0) return false;
	const suffix = commandLine.slice(routeIndex + route.length);
	if (suffix !== "" && !suffix.startsWith(" ")) return false;
	if (realpathSync(processExecutable) !== realpathSync(expectedExecutable)) return false;
	const prefix = commandLine.slice(0, routeIndex);
	// The launch spelling may be a stable release symlink. It is only argv
	// syntax; processExecutable is independently bound to the living PID.
	for (const executable of [expectedExecutable, launchExecutable, "node"]) {
		if (!prefix.startsWith(`${executable} `)) continue;
		const entry = prefix.slice(executable.length + 1);
		// Require an absolute script path and no preceding Node execution options.
		if (!entry.startsWith("/")) continue;
		if (realpathSync(entry) === realpathSync(reviewEntry)) return true;
		// The combined installer keeps the general CLI beside its smaller signed
		// service tree. Accept only that exact sibling, with matching review code.
		const serviceRoot = realpathSync(resolve(dirname(reviewEntry), "../../../.."));
		const relativeEntry = "node_modules/@harnessy/core/dist/cli.js";
		const sibling = join(dirname(serviceRoot), relativeEntry);
		const uid = process.geteuid?.();
		if (
			uid === undefined ||
			basename(serviceRoot) !== "service" ||
			realpathSync(reviewEntry) !== join(serviceRoot, relativeEntry) ||
			realpathSync(entry) !== sibling
		)
			return false;
		for (const relative of [
			"dist/cli.js",
			"dist/jarvis/community-briefing/native-draft.js",
			"dist/jarvis/community-briefing/review-process.js",
			// The weekly trigger runs in the reviewer and writes drafts through it.
			"dist/cli/community-draft.js",
			"dist/jarvis/community-briefing/weekly-generation.js",
			"resources/community-draft-adapter.py",
		]) {
			const expected = readStableMeetingPublicationSmokeFile(
				join(serviceRoot, "node_modules/@harnessy/core", relative),
				BigInt(uid),
				"artifact",
				1048576,
			);
			const observed = readStableMeetingPublicationSmokeFile(
				join(dirname(serviceRoot), "node_modules/@harnessy/core", relative),
				BigInt(uid),
				"artifact",
				1048576,
			);
			if (sha256MeetingPublicationSmokeBytes(expected.bytes) !== sha256MeetingPublicationSmokeBytes(observed.bytes))
				return false;
		}
		return true;
	}
	return false;
};

/** @internal Parse lsof's NUL-delimited field output. On macOS the first txt
 * record is the process executable; later txt records may be libraries.
 */
export const darwinProcessExecutableFromLsof = (output: string, pid: number): string | undefined => {
	const lines = output.split("\n");
	if (lines.pop() !== "" || lines.shift() !== `p${pid}\0` || lines.length === 0) return undefined;
	const paths: string[] = [];
	for (const line of lines) {
		const fields = line.split("\0");
		if (fields.pop() !== "" || fields.length !== 2 || fields[0] !== "ftxt" || !fields[1]?.startsWith("n/"))
			return undefined;
		paths.push(fields[1].slice(1));
	}
	return paths[0];
};

/** A label alone never exempts a legacy or stopped reviewer. */
export const isNativeCommunityReviewLaunchAgent = (
	label: string,
	output: string,
	verifiedProcessIds: ReadonlySet<number>,
): boolean => {
	const pids = [...output.matchAll(/^\s*pid = (\d+)\s*$/gmu)];
	return (
		label === "com.flow-harness.community-review-v2" &&
		pids.length === 1 &&
		verifiedProcessIds.has(Number(pids[0]![1]))
	);
};
/** @internal Grammar of one OS process record, before filtering by owner. */
export const communityProcessLinePattern = /^\s*(-?\d+)\s+(\d+)\s+(.+)$/u;

/** @internal Parse the exact single record returned by a PID-scoped ps probe. */
export const parseCommunityProcessConfirmation = (output: string): RegExpExecArray | undefined => {
	const record = output.endsWith("\n") ? output.slice(0, -1) : output;
	if (record === "" || record.includes("\n") || record.includes("\r")) return undefined;
	return communityProcessLinePattern.exec(record) ?? undefined;
};

const COMMUNITY_COMPATIBILITY_WRITER_COMMANDS = [
	["jarvis", "meeting", "publish", "review", "serve"],
	["jarvis", "meeting", "review", "serve"],
	...["jarvis", "harnessy", "hsy"].flatMap((program) => [
		[program, "community", "briefing"],
		[program, "community-briefing"],
	]),
] as const;

/** @internal A process running a meeting/community writer command or a launched
 * community briefing script. Text naming those commands inside another command's
 * arguments (shells, search tools, agents, inline programs) is not a writer.
 */
export const isCommunityCompatibilityWriterCommand = (commandLine: string): boolean =>
	COMMUNITY_COMPATIBILITY_WRITER_COMMANDS.some((words) => invokesCommand(commandLine, words)) ||
	launchedPrograms(commandLine).some((program) =>
		/(?:jarvis|harnessy|hsy).*\/community-briefing\/|briefing[-_](?:review|worker)/u.test(program),
	);

/** A probe executable that failed the root-owned, non-writable check. */
const isTamperEvidence = (cause: unknown) => cause instanceof Error && cause.message === "unsafe_probe";

/** Bounded known-process evidence, not protection from arbitrary same-UID code. */
const proveCompatibilityAbsentWith = (
	run: ProcessProbeRunner,
	platform: NodeJS.Platform,
	nativeReviewer: { readonly executable: string; readonly entry: string },
) => {
	const command = (check: WriterCheckName, path: string, args: ReadonlyArray<string>) =>
		runWriterCheckProbe(run, check, path, args);
	const darwinProcessExecutable = (pid: number): string => {
		const result = command("lsof", "/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-F0pfn"]);
		if (result.status !== 0) throw new WriterCheckInconclusiveError("lsof", "exit_status", result.status);
		if (result.stderr !== "") throw new Error("probe_failed");
		const executable = darwinProcessExecutableFromLsof(result.stdout, pid);
		if (executable === undefined) throw new Error("probe_failed");
		return executable;
	};
	const uid = process.geteuid?.();
	if (uid === undefined) throw new Error("unsupported_platform");
	if (platform !== "darwin" && platform !== "linux") throw new Error("unsupported_platform");
	const scanProcesses = () => command("ps", "/bin/ps", ["-axo", "uid=,pid=,command="]);
	/** Whether a writer-shaped process is exempt as this installation's native reviewer. */
	const isNativeReviewer = (pid: string, commandLine: string) => {
		const launchExecutable = command("ps", "/bin/ps", ["-p", pid, "-o", "comm="]);
		if (launchExecutable.status !== 0)
			throw new WriterCheckInconclusiveError("ps", "exit_status", launchExecutable.status);
		const processExecutable = platform === "linux" ? `/proc/${pid}/exe` : darwinProcessExecutable(Number(pid));
		const confirmed = command("ps", "/bin/ps", ["-p", pid, "-o", "uid=,pid=,command="]);
		if (confirmed.status !== 0) throw new WriterCheckInconclusiveError("ps", "exit_status", confirmed.status);
		const confirmedMatch = parseCommunityProcessConfirmation(confirmed.stdout);
		return (
			confirmedMatch !== undefined &&
			Number(confirmedMatch[1]) === uid &&
			confirmedMatch[2] === pid &&
			confirmedMatch[3] === commandLine &&
			isNativeCommunityReviewProcess(
				commandLine,
				launchExecutable.stdout.trim(),
				processExecutable,
				nativeReviewer.executable,
				nativeReviewer.entry,
			)
		);
	};
	/** A fresh complete scan that no longer lists the PID with the same command proves it ended. */
	const hasEnded = (pid: string, commandLine: string) => {
		const fresh = Result.try({ try: scanProcesses, catch: (cause) => cause });
		if (Result.isFailure(fresh) && isTamperEvidence(fresh.failure)) throw fresh.failure;
		if (Result.isFailure(fresh) || fresh.success.status !== 0) return false;
		let ended = true;
		for (const line of fresh.success.stdout.split("\n")) {
			if (!line.trim()) continue;
			const match = communityProcessLinePattern.exec(line);
			if (!match) return false;
			if (Number(match[1]) === uid && match[2] === pid && match[3] === commandLine) ended = false;
		}
		return ended;
	};
	const nativeReviewProcesses = new Set<number>();
	/** Writer-shaped PIDs whose exemption check could not answer. */
	const unverifiedExemptions = new Map<number, WriterCheckInconclusiveError>();
	/** Set when the process listing itself could not answer, so no PID could be checked. */
	let processListing: WriterCheckInconclusiveError | undefined;
	const proveProcessesAbsent = () => {
		const listed = Result.try({ try: scanProcesses, catch: (cause) => cause });
		if (Result.isFailure(listed)) {
			if (listed.failure instanceof WriterCheckInconclusiveError) processListing = listed.failure;
			throw listed.failure;
		}
		const processes = listed.success;
		for (const line of processes.stdout.split("\n")) {
			if (!line.trim()) continue;
			const match = communityProcessLinePattern.exec(line);
			if (!match) throw new Error("probe_failed");
			if (Number(match[1]) !== uid || Number(match[2]) === process.pid) continue;
			if (!isCommunityCompatibilityWriterCommand(match[3])) continue;
			const native = Result.try({ try: () => isNativeReviewer(match[2], match[3]), catch: (cause) => cause });
			if (Result.isSuccess(native)) {
				// A definitive "not exempt" answer is an observed writer.
				if (!native.success) throw new Error("compatibility_writer_present");
				nativeReviewProcesses.add(Number(match[2]));
				continue;
			}
			// An exemption probe that could not answer (e.g. lsof timing out in a dark wake)
			// pauses rather than stops; keep scanning so an observed writer still wins.
			if (native.failure instanceof WriterCheckInconclusiveError) {
				unverifiedExemptions.set(Number(match[2]), native.failure);
				continue;
			}
			// Tamper evidence from a probe always stops, even if the process ends meanwhile.
			if (isTamperEvidence(native.failure)) throw native.failure;
			// Any other unverifiable answer fails closed unless the process has since ended.
			if (!hasEnded(match[2], match[3])) throw new Error("compatibility_writer_present");
		}
		// Writers in the output of a failed scan still stop at once (above); otherwise the
		// failed scan, or an unanswered exemption check, proves nothing.
		if (processes.status !== 0) {
			processListing = new WriterCheckInconclusiveError("ps", "exit_status", processes.status);
			throw processListing;
		}
		const [unverified] = unverifiedExemptions.values();
		if (unverified !== undefined) throw unverified;
	};
	const proveSchedulersAbsent = () => {
		if (platform === "darwin") {
			runAllWriterCheckProbes(
				COMMUNITY_GUARD_LABELS.map((label) => () => {
					const result = command("launchctl", "/bin/launchctl", ["print", `gui/${uid}/${label}`]);
					if (
						result.status === 0 &&
						isNativeCommunityReviewLaunchAgent(label, result.stdout, nativeReviewProcesses)
					)
						return;
					// Only the native review agent can be exempt, and only while it runs exactly one
					// process. That process's exemption is inconclusive when its own check could not
					// answer, or when the process listing could not answer so it could not be checked.
					// A loaded agent with no process, several processes, or a refuted process is a writer.
					if (result.status === 0 && label === "com.flow-harness.community-review-v2") {
						const pids = [...result.stdout.matchAll(/^\s*pid = (\d+)\s*$/gmu)];
						const pid = pids.length === 1 ? Number(pids[0]![1]) : undefined;
						const pending = pid === undefined ? undefined : (unverifiedExemptions.get(pid) ?? processListing);
						if (pending !== undefined) throw pending;
					}
					// Any other loaded job is an observed writer; only "Could not find service" proves absence.
					if (result.status === 0) throw new Error("compatibility_writer_present");
					if (!`${result.stdout}\n${result.stderr}`.includes("Could not find service"))
						throw new WriterCheckInconclusiveError("launchctl", "exit_status", result.status);
				}),
			);
			return;
		}
		const result = command("crontab", "/usr/bin/crontab", ["-l"]);
		if (/community[- ]briefing|briefing[-_]review/u.test(result.stdout))
			throw new Error("compatibility_writer_present");
		if (result.status !== 0 && !/no crontab for/iu.test(result.stderr))
			throw new WriterCheckInconclusiveError("crontab", "exit_status", result.status);
	};
	// Every probe runs; an unanswered probe never hides an observed writer.
	runAllWriterCheckProbes([proveProcessesAbsent, proveSchedulersAbsent]);
};

/**
 * @internal The production compatibility-writer proof over an injectable process runner.
 * An observed writer throws `compatibility_writer_present`; an unanswered probe throws
 * `WriterCheckInconclusiveError`.
 */
export const makeCommunityCompatibilityProof =
	(
		run: ProcessProbeRunner,
		platform: NodeJS.Platform = process.platform,
		nativeReviewer = {
			executable: process.execPath,
			entry: fileURLToPath(new URL("../../cli.js", import.meta.url)),
		},
	) =>
	(): void =>
		proveCompatibilityAbsentWith(run, platform, nativeReviewer);

/** Source-private fixture seam; no observer, bypass or signing key is accepted by the CLI. */
export const CommunityOperationSystemReference = Context.Reference<{
	readonly proveCompatibilityAbsent: () => void;
	readonly coreAnchor: string;
	/** Receives allow-listed writer-check events; defaults to one JSON line on stderr. */
	readonly reportWriterCheck?: WriterCheckReporter;
}>("@harnessy/core/CommunityOperationSystem", {
	defaultValue: () => ({
		proveCompatibilityAbsent: makeCommunityCompatibilityProof(liveProbeRunner),
		coreAnchor: realpathSync(fileURLToPath(import.meta.url)),
	}),
});

export class CommunityOperationError extends Schema.TaggedErrorClass<CommunityOperationError>()(
	"CommunityOperationError",
	{
		code: Schema.Literals([
			"invalid_authorization",
			"runtime_rejected",
			"publication_uncertain",
			"reconciliation_required",
		]),
		/** Diagnostic identifier of the runtime check that rejected the operation. */
		reason: Schema.optional(Schema.String),
	},
) {}

/** Only fixed internal identifiers, never free-form error text, become diagnostics. */
const rejectionReason = (cause: unknown): string | undefined =>
	cause instanceof WriterCheckInconclusiveError
		? cause.reason
		: cause instanceof Error && /^[a-z][a-z_]{0,63}$/u.test(cause.message)
			? cause.message
			: undefined;

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

/** Inert preparation observes this runtime; it does not probe or stop other writers. */
export const prepareCommunityPublicationService = (
	value: unknown,
	anchors: CommunityOperationConsumer["artifactAnchors"],
	outputDirectory: string,
) =>
	Effect.gen(function* () {
		const runtime = yield* MeetingPublicationSmokeRuntimeSystemReference;
		const system = yield* CommunityOperationSystemReference;
		return yield* Effect.try(() =>
			prepareCommunityServiceRequest(
				value,
				runtime.observe(),
				{ ...anchors, core: system.coreAnchor },
				outputDirectory,
			),
		);
	});

/** Read status or irreversibly revoke this enrollment while stopped; never clear a lease. */
export const controlCommunityPublicationService = (
	input: MeetingPublicationSmokeRuntimeInput,
	action: "status" | "revoke",
) =>
	Effect.gen(function* () {
		const system = yield* MeetingPublicationSmokeRuntimeSystemReference;
		return yield* Effect.try({
			try: () => {
				const { envelope, assertLedger, digest } = readCommunityServiceEnrollment(input, system.observe());
				const database = new DatabaseSync(envelope.operational.ledger.path, {
					readOnly: action === "status",
					allowExtension: false,
					timeout: 1000,
				});
				try {
					database.exec(
						action === "status"
							? "PRAGMA trusted_schema=OFF; BEGIN"
							: "PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE",
					);
					assertLedger();
					if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger'").get())
						throw new Error("ledger_trigger");
					const enrolled = database
						.prepare("SELECT payload_hash,consumed_at,revoked FROM community_briefing_grants WHERE grant_id=?")
						.get(envelope.grantId);
					if (
						enrolled &&
						((enrolled.payload_hash !== digest &&
							!(enrolled.payload_hash === "" && enrolled.consumed_at === null && enrolled.revoked === 1)) ||
							(enrolled.revoked !== 0 && enrolled.revoked !== 1) ||
							(enrolled.revoked === 0 && (typeof enrolled.consumed_at !== "string" || !enrolled.consumed_at)))
					)
						throw new Error("enrollment_changed");
					const lease = database
						.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='community_briefing_lease'")
						.get()
						? database.prepare("SELECT 1 FROM community_briefing_lease").get()
						: undefined;
					if (action === "revoke") {
						if (lease) throw new CommunityOperationError({ code: "reconciliation_required" });
						database
							.prepare(
								"INSERT INTO community_briefing_grants(grant_id,payload_hash,revoked) VALUES (?,?,1) ON CONFLICT(grant_id) DO UPDATE SET revoked=1",
							)
							.run(envelope.grantId, digest);
						database.exec("COMMIT");
					}
					return {
						kind: "harnessy.community.briefing.service-status" as const,
						revoked: action === "revoke" || enrolled?.revoked === 1,
						enrollment:
							typeof enrolled?.consumed_at === "string" ? ("enrolled" as const) : ("not_started" as const),
						ownership: lease ? ("lease_recorded" as const) : ("none" as const),
						runtimeHealth: "not_assessed" as const,
					};
				} finally {
					database.close();
				}
			},
			catch: (cause) =>
				cause instanceof CommunityOperationError
					? cause
					: new CommunityOperationError({ code: "runtime_rejected" }),
		});
	});

/** One scoped publication under one-shot or service authority; never repairs uncertainty. */
export const runAuthorizedCommunityBriefing = (
	input: MeetingPublicationSmokeRuntimeInput,
	consumer:
		| CommunityOperationConsumer
		| {
				readonly artifactAnchors: CommunityOperationConsumer["artifactAnchors"];
				readonly enrollOnly: true;
		  },
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
			if ("enrollOnly" in consumer && !verified.service)
				return yield* new CommunityOperationError({ code: "invalid_authorization" });
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
					catch: (cause) => {
						// Keep the typed probe error so the pre-lease retry can recognize it.
						if (cause instanceof WriterCheckInconclusiveError) return cause;
						const reason = rejectionReason(cause);
						return new CommunityOperationError({
							code: "runtime_rejected",
							...(reason === undefined ? {} : { reason }),
						});
					},
				});
			/**
			 * Before any lease exists, an unanswered probe skips publication. A service run retries
			 * it with bounded backoff and escalates to the existing rejection after the window; a
			 * one-shot run fails fast. An observed writer always fails at once.
			 */
			const beforeLease = <A, E>(effect: Effect.Effect<A, E>) =>
				retryWhileWriterCheckInconclusive(effect, {
					service: "community",
					inconclusive: (cause) => (cause instanceof WriterCheckInconclusiveError ? cause : undefined),
					escalate: (cause) => new CommunityOperationError({ code: "runtime_rejected", reason: cause.reason }),
					report: system.reportWriterCheck ?? stderrWriterCheckReporter,
					failFast: !verified.service,
				});
			yield* beforeLease(check());
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
			if (verified.service)
				yield* Effect.try(() => {
					verified.assertLedger();
					host.enrollService(envelope);
				});
			// Adopt verified, quiescent state before a combined host opens its shared
			// Executor. This issues no item grant and cannot call a provider.
			if ("enrollOnly" in consumer)
				return { kind: "harnessy.community.briefing.publication-result" as const, status: "enrolled" as const };
			const item = yield* Effect.try(() => {
				if (!verified.service) return { briefingId: envelope.briefingId!, sourceHash: envelope.sourceHash! };
				const queue = new DatabaseSync(envelope.queuePath, { readOnly: true, allowExtension: false });
				try {
					if (
						queue.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger'").get() ||
						queue
							.prepare("SELECT 1 FROM community_briefings WHERE status='publishing' OR lease_until IS NOT NULL")
							.get()
					)
						throw new Error("community_queue_requires_reconciliation");
					const row = queue
						.prepare(
							"SELECT briefing_id,draft_hash FROM community_briefings WHERE status='approved' AND approved_hash=draft_hash AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY week_start LIMIT 1",
						)
						.get(new Date(initial.now).toISOString());
					if (!row) return undefined;
					if (
						typeof row.briefing_id !== "string" ||
						!/^[a-f0-9]{24}$/u.test(row.briefing_id) ||
						typeof row.draft_hash !== "string" ||
						!/^[a-f0-9]{64}$/u.test(row.draft_hash)
					)
						throw new Error("invalid_approved_item");
					return { briefingId: row.briefing_id, sourceHash: row.draft_hash };
				} finally {
					queue.close();
				}
			});
			if (item === undefined)
				return { kind: "harnessy.community.briefing.publication-result" as const, status: "idle" as const };
			const binding = host.bind(envelope, {
				check,
				assertLedger: verified.assertLedger,
				...(verified.service
					? { serviceItem: item, bootId: initial.bootId, deadline: new Date(verified.expiry).toISOString() }
					: {}),
			});
			const grant = yield* beforeLease(binding.authorize());
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
			if (result.briefingId !== item.briefingId || !result.googleDocId || !result.discordMessageId)
				return yield* new CommunityOperationError({ code: "publication_uncertain" });
			yield* Effect.try(() => binding.complete());
			return { kind: "harnessy.community.briefing.publication-result" as const, status: "published" as const };
		}),
	).pipe(
		Effect.mapError((cause) =>
			cause instanceof CommunityOperationError
				? cause
				: new CommunityOperationError({
						code: "runtime_rejected",
						...(cause instanceof WriterCheckInconclusiveError ? { reason: cause.reason } : {}),
					}),
		),
	);
