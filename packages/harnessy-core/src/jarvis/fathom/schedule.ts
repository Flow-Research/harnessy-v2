import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import * as Effect from "effect/Effect";

import type { JarvisPaths } from "../paths.ts";

export const FATHOM_LAUNCH_AGENT_LABEL = "com.flow-harness.meeting-fathom-poll" as const;
export const FATHOM_POLL_INTERVAL_SECONDS = 5 * 60;

export interface FathomScheduleOptions {
	readonly nodePath: string;
	readonly cliPath: string;
	readonly launchAgentsDirectory: string;
	readonly now?: Date;
}

export interface FathomScheduleFile {
	readonly label: typeof FATHOM_LAUNCH_AGENT_LABEL;
	readonly path: string;
	readonly content: string;
}

export interface FathomScheduleResult {
	readonly applied: boolean;
	readonly backupDirectory: string | null;
	readonly file: FathomScheduleFile;
}

const xml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");

const renderPlist = (paths: JarvisPaths, options: FathomScheduleOptions): string => {
	const log = join(paths.canonicalGlobalRoot, "logs", `${FATHOM_LAUNCH_AGENT_LABEL}.log`);
	const argumentsList = [
		options.nodePath,
		options.cliPath,
		"jarvis",
		"meeting",
		"fathom",
		"poll",
		"--target",
		paths.targetDir,
		"--json",
	];
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xml(FATHOM_LAUNCH_AGENT_LABEL)}</string>
	<key>ProgramArguments</key>
	<array>
${argumentsList.map((argument) => `\t\t<string>${xml(argument)}</string>`).join("\n")}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>${xml(resolve(paths.canonicalGlobalRoot, "..", ".."))}</string>
		<key>FLOW_PROJECT_ROOT</key>
		<string>${xml(paths.targetDir)}</string>
		<key>PATH</key>
		<string>${xml(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")}</string>
	</dict>
	<key>StartInterval</key>
	<integer>${FATHOM_POLL_INTERVAL_SECONDS}</integer>
	<key>RunAtLoad</key>
	<false/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>WorkingDirectory</key>
	<string>${xml(paths.targetDir)}</string>
	<key>StandardOutPath</key>
	<string>${xml(log)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(log)}</string>
</dict>
</plist>
`;
};

const validate = (paths: JarvisPaths, options: FathomScheduleOptions) => {
	if (!isAbsolute(options.launchAgentsDirectory)) throw new Error("LaunchAgents directory must be absolute.");
	for (const [label, value] of [
		["Node", options.nodePath],
		["V2 CLI", options.cliPath],
		["target", paths.targetDir],
	] as const) {
		if (!isAbsolute(value) || !existsSync(value))
			throw new Error(`${label} path is not an existing absolute path: ${value}`);
	}
};

export const planFathomSchedule = (
	paths: JarvisPaths,
	options: FathomScheduleOptions,
): Effect.Effect<FathomScheduleFile, Error> =>
	Effect.try({
		try: () => {
			validate(paths, options);
			return {
				label: FATHOM_LAUNCH_AGENT_LABEL,
				path: join(resolve(options.launchAgentsDirectory), `${FATHOM_LAUNCH_AGENT_LABEL}.plist`),
				content: renderPlist(paths, options),
			};
		},
		catch: (cause) => (cause instanceof Error ? cause : new Error("Unable to plan the V2 Fathom schedule.")),
	});

/** Atomically installs only the Fathom candidate; launchd load/start remains separate. */
export const installFathomSchedule = (
	paths: JarvisPaths,
	options: FathomScheduleOptions,
): Effect.Effect<FathomScheduleResult, Error> =>
	Effect.gen(function* () {
		const file = yield* planFathomSchedule(paths, options);
		return yield* Effect.try({
			try: () => {
				const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
				const backupDirectory = join(paths.canonicalGlobalRoot, "backups", stamp, "LaunchAgents");
				mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
				mkdirSync(options.launchAgentsDirectory, { recursive: true, mode: 0o700 });
				mkdirSync(join(paths.canonicalGlobalRoot, "logs"), { recursive: true, mode: 0o700 });
				if (existsSync(file.path))
					writeFileSync(join(backupDirectory, basename(file.path)), readFileSync(file.path), { mode: 0o600 });
				const temporary = `${file.path}.${process.pid}.tmp`;
				writeFileSync(temporary, file.content, { encoding: "utf8", mode: 0o600 });
				renameSync(temporary, file.path);
				writeFileSync(
					join(backupDirectory, "rollback.json"),
					`${JSON.stringify({ createdAt: (options.now ?? new Date()).toISOString(), label: file.label, path: file.path }, null, 2)}\n`,
					{ encoding: "utf8", mode: 0o600 },
				);
				return { applied: true, backupDirectory, file };
			},
			catch: (cause) => (cause instanceof Error ? cause : new Error("Unable to install the V2 Fathom schedule.")),
		});
	});
