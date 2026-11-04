import type {
	MeetingPublicationImportError,
	MeetingPublicationImportInput,
	MeetingPublicationImportResult,
} from "@harnessy/core/meeting-publication";
import * as Effect from "effect/Effect";

import { isMeetingCommandSha256, isSafeAbsoluteMeetingCommandPath } from "./meeting-command-input.ts";
import { runLocalHostMeetingImport } from "./meeting-import-runtime.ts";

const required = [
	"--backup",
	"--backup-sha256",
	"--source-snapshot",
	"--v1-source",
	"--project",
	"--v1-state",
	"--output-directory",
];

export type MeetingImportCommandResult =
	| {
			readonly exitCode: 0;
			readonly stream: "stdout";
			readonly value: MeetingPublicationImportResult;
	  }
	| {
			readonly exitCode: 1;
			readonly stream: "stderr";
			readonly value: {
				readonly error: "meeting_import_failed";
				readonly code: MeetingPublicationImportError["code"] | "invalid_arguments";
			};
	  };

const parseInput = (args: ReadonlyArray<string>): Effect.Effect<MeetingPublicationImportInput, "invalid_arguments"> =>
	Effect.gen(function* () {
		if (args.length !== required.length * 2) return yield* Effect.fail("invalid_arguments" as const);
		const options = new Map<string, string>();
		for (let index = 0; index < args.length; index += 2) {
			const name = args[index];
			const value = args[index + 1];
			if (
				name === undefined ||
				value === undefined ||
				!required.includes(name) ||
				options.has(name) ||
				value.length === 0 ||
				value.startsWith("--")
			) {
				return yield* Effect.fail("invalid_arguments" as const);
			}
			options.set(name, value);
		}
		const pathValues = {
			backup: options.get("--backup") ?? "",
			sourceSnapshotPath: options.get("--source-snapshot") ?? "",
			v1SourcePath: options.get("--v1-source") ?? "",
			v1StatePath: options.get("--v1-state") ?? "",
			outputDirectory: options.get("--output-directory") ?? "",
		};
		const project = options.get("--project") ?? "";
		const sha256 = options.get("--backup-sha256") ?? "";
		if (
			!Object.values(pathValues).every(isSafeAbsoluteMeetingCommandPath) ||
			!isMeetingCommandSha256(sha256) ||
			!/^[a-z0-9][a-z0-9_-]{0,255}$/u.test(project)
		) {
			return yield* Effect.fail("invalid_arguments" as const);
		}
		return {
			backup: { path: pathValues.backup, sha256 },
			sourceSnapshotPath: pathValues.sourceSnapshotPath,
			v1SourcePath: pathValues.v1SourcePath,
			project,
			v1StatePath: pathValues.v1StatePath,
			outputDirectory: pathValues.outputDirectory,
		};
	});

/** Internal exact-argv adapter; it neither discovers inputs nor chooses an output directory. */
export const runMeetingImportCommand = (args: ReadonlyArray<string>): Effect.Effect<MeetingImportCommandResult> =>
	parseInput(args).pipe(
		Effect.flatMap(runLocalHostMeetingImport),
		Effect.match({
			onFailure: (cause): MeetingImportCommandResult => ({
				exitCode: 1,
				stream: "stderr",
				value: { error: "meeting_import_failed", code: cause === "invalid_arguments" ? cause : cause.code },
			}),
			onSuccess: (result): MeetingImportCommandResult => ({ exitCode: 0, stream: "stdout", value: result }),
		}),
	);
