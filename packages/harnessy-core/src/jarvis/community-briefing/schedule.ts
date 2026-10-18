import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import * as Effect from "effect/Effect";

import type { JarvisPaths } from "../paths.ts";

/**
 * The native community review service. It is the one process the community
 * one-writer guard exempts as a draft writer, and it owns weekly generation
 * in-process, so the schedule needs no second label or generator argv.
 */
export const COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL = "com.flow-harness.community-review-v2" as const;
export const COMMUNITY_REVIEW_PORT = 8872;
/** The service whose community worker the guard protects. */
export const PUBLICATION_LAUNCH_AGENT_LABEL = "org.harnessy.meeting-publication" as const;
/** launchd waits at least this long between restarts of a crashing reviewer. */
export const COMMUNITY_REVIEW_THROTTLE_SECONDS = 10;

export interface CommunityReviewScheduleOptions {
	readonly nodePath: string;
	readonly cliPath: string;
	readonly configPath: string;
	/** Omit to use `community_briefing.python_path` from the configuration. */
	readonly pythonPath?: string;
	readonly port?: number;
	readonly launchAgentsDirectory: string;
	readonly now?: Date;
	/**
	 * Install only: the publication service's ProgramArguments, so the reviewer is
	 * bound to the same release; `null` when no publication service runs here.
	 */
	readonly publication?: ReadonlyArray<string> | null;
}

export interface CommunityReviewScheduleFile {
	readonly label: typeof COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL;
	readonly path: string;
	readonly content: string;
	/** The exact argv launchd runs, for one-writer classification before install. */
	readonly programArguments: ReadonlyArray<string>;
}

export interface CommunityReviewScheduleResult {
	readonly applied: boolean;
	readonly backupDirectory: string | null;
	readonly file: CommunityReviewScheduleFile;
}

const xml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");

/** The review route the guard recognizes; weekly generation is configured, not a flag. */
export const communityReviewProgramArguments = (options: CommunityReviewScheduleOptions): ReadonlyArray<string> => [
	options.nodePath,
	options.cliPath,
	"jarvis",
	"community",
	"briefing",
	"review",
	"serve",
	"--config",
	options.configPath,
	...(options.pythonPath === undefined ? [] : ["--python-path", options.pythonPath]),
	"--port",
	String(options.port ?? COMMUNITY_REVIEW_PORT),
	// Only this LaunchAgent runs the weekly trigger; a foreground review never does.
	"--weekly-generation",
];

const renderPlist = (paths: JarvisPaths, programArguments: ReadonlyArray<string>): string => {
	const log = join(paths.canonicalGlobalRoot, "logs", `${COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL}.log`);
	// KeepAlive: a loaded review label without a process is a writer to the
	// community guard, so a crashed reviewer must come back. ThrottleInterval
	// bounds a crash loop (for example a broken configuration) to one start per
	// interval.
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xml(COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL)}</string>
	<key>ProgramArguments</key>
	<array>
${programArguments.map((argument) => `\t\t<string>${xml(argument)}</string>`).join("\n")}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>${xml(resolve(paths.canonicalGlobalRoot, "..", ".."))}</string>
		<key>FLOW_PROJECT_ROOT</key>
		<string>${xml(paths.targetDir)}</string>
		<key>PATH</key>
		<string>${xml(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")}</string>
		<key>PYTHONDONTWRITEBYTECODE</key>
		<string>1</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>${COMMUNITY_REVIEW_THROTTLE_SECONDS}</integer>
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

const validate = (paths: JarvisPaths, options: CommunityReviewScheduleOptions) => {
	if (!isAbsolute(options.launchAgentsDirectory)) throw new Error("LaunchAgents directory must be absolute.");
	const port = options.port ?? COMMUNITY_REVIEW_PORT;
	if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
		throw new Error("Community review port must be between 1024 and 65535.");
	for (const [label, value] of [
		["Node", options.nodePath],
		["V2 CLI", options.cliPath],
		["configuration", options.configPath],
		["target", paths.targetDir],
		...(options.pythonPath === undefined ? [] : ([["Python", options.pythonPath]] as const)),
	] as const) {
		if (!isAbsolute(value) || !existsSync(value))
			throw new Error(`${label} path is not an existing absolute path: ${value}`);
	}
};

export const planCommunityReviewSchedule = (
	paths: JarvisPaths,
	options: CommunityReviewScheduleOptions,
): Effect.Effect<CommunityReviewScheduleFile, Error> =>
	Effect.try({
		try: () => {
			validate(paths, options);
			const programArguments = communityReviewProgramArguments(options);
			return {
				label: COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL,
				path: join(resolve(options.launchAgentsDirectory), `${COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL}.plist`),
				content: renderPlist(paths, programArguments),
				programArguments,
			};
		},
		catch: (cause) =>
			cause instanceof Error ? cause : new Error("Unable to plan the V2 community review LaunchAgent."),
	});

/**
 * The reviewer the guard exempts must run the same release as the publication
 * service. The service runs `<release>/bin/node` with
 * `<release>/service/node_modules/@harnessy/…`; the reviewer must run that Node
 * with `<release>/node_modules/@harnessy/core/dist/cli.js`.
 */
export const expectedReviewerRelease = (publication: ReadonlyArray<string>) => {
	const [node, entry] = publication;
	const marker = "/service/node_modules/@harnessy/";
	const index = entry?.lastIndexOf(marker) ?? -1;
	if (node === undefined || entry === undefined || !isAbsolute(node) || index <= 0)
		throw new Error("The publication service does not run from an installed Harnessy release.");
	return { nodePath: node, cliPath: join(entry.slice(0, index), "node_modules/@harnessy/core/dist/cli.js") };
};

const assertSameRelease = (options: CommunityReviewScheduleOptions) => {
	if (options.publication === null) return;
	if (options.publication === undefined)
		throw new Error(
			"Installing the reviewer needs the publication service's release: pass --publication-plist, or --without-publication when no publication service runs on this machine.",
		);
	const expected = expectedReviewerRelease(options.publication);
	const same = (left: string, right: string) => existsSync(right) && realpathSync(left) === realpathSync(right);
	if (!same(options.nodePath, expected.nodePath) || !same(options.cliPath, expected.cliPath))
		throw new Error(
			`The reviewer must run the publication service's release: use --node-path ${expected.nodePath} --cli-entry ${expected.cliPath}.`,
		);
};

/** Atomically installs only the review candidate; launchd bootout/bootstrap remains separate. */
export const installCommunityReviewSchedule = (
	paths: JarvisPaths,
	options: CommunityReviewScheduleOptions,
): Effect.Effect<CommunityReviewScheduleResult, Error> =>
	Effect.gen(function* () {
		const file = yield* planCommunityReviewSchedule(paths, options);
		return yield* Effect.try({
			try: () => {
				assertSameRelease(options);
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
			catch: (cause) =>
				cause instanceof Error ? cause : new Error("Unable to install the V2 community review LaunchAgent."),
		});
	});
