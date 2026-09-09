import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import * as Effect from "effect/Effect";

import type { LifeOrchestratorSettings } from "./config.ts";
import { LifeOrchestratorError } from "./models.ts";

export const LIFE_LAUNCH_AGENT_LABELS = [
	"com.flow-harness.life-orchestrator.learning-research",
	"com.flow-harness.life-orchestrator.daily-brief",
	"com.flow-harness.life-orchestrator.weekly-plan",
] as const;

type LifeLaunchAgentLabel = (typeof LIFE_LAUNCH_AGENT_LABELS)[number];

export interface LifeScheduleOptions {
	readonly nodePath: string;
	readonly cliPath: string;
	readonly launchAgentsDirectory: string;
	readonly now?: Date;
}

export interface LifeScheduleFile {
	readonly label: LifeLaunchAgentLabel;
	readonly path: string;
	readonly content: string;
}

export interface LifeScheduleResult {
	readonly applied: boolean;
	readonly backupDirectory: string | null;
	readonly files: ReadonlyArray<LifeScheduleFile>;
}

const xml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");

const scheduleFor = (
	label: LifeLaunchAgentLabel,
): { readonly hour: number; readonly minute: number; readonly weekday: number | null; readonly command: string } => {
	if (label.endsWith("learning-research")) return { hour: 4, minute: 15, weekday: null, command: "research" };
	if (label.endsWith("daily-brief")) return { hour: 5, minute: 30, weekday: null, command: "daily" };
	return { hour: 18, minute: 0, weekday: 0, command: "weekly" };
};

const renderPlist = (
	label: LifeLaunchAgentLabel,
	settings: LifeOrchestratorSettings,
	options: LifeScheduleOptions,
): string => {
	const schedule = scheduleFor(label);
	const log = join(settings.paths.stateDirectory, "logs", `${label}.log`);
	const argumentsList = [
		options.nodePath,
		options.cliPath,
		"jarvis",
		"life",
		schedule.command,
		"--target",
		settings.paths.projectRoot,
		"--home-root",
		settings.paths.homeRoot,
		"--compatibility-root",
		settings.paths.compatibilityScriptsDirectory,
	];
	const weekday =
		schedule.weekday === null ? "" : `\n\t\t<key>Weekday</key>\n\t\t<integer>${schedule.weekday}</integer>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xml(label)}</string>
	<key>ProgramArguments</key>
	<array>
${argumentsList.map((argument) => `\t\t<string>${xml(argument)}</string>`).join("\n")}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>${xml(settings.paths.homeRoot)}</string>
		<key>FLOW_PROJECT_ROOT</key>
		<string>${xml(settings.paths.projectRoot)}</string>
		<key>AGENTS_LIFE_DIR</key>
		<string>${xml(settings.paths.lifeDirectory)}</string>
		<key>HARNESSY_LIFE_V1_SCRIPTS</key>
		<string>${xml(settings.paths.compatibilityScriptsDirectory)}</string>
		<key>FLOW_AI_PROVIDER</key>
		<string>auto</string>
		<key>FLOW_AI_PROVIDER_ORDER</key>
		<string>codex,opencode,claude</string>
		<key>HARNESSY_AI_PROVIDER</key>
		<string>auto</string>
		<key>HARNESSY_AI_PROVIDER_ORDER</key>
		<string>codex,opencode,claude</string>
		<key>FLOW_CRON_PROMPT_RUNNER</key>
		<string>codex</string>
		<key>HARNESSY_AI_CODEX_DEFAULT_MODEL</key>
		<string>gpt-6-astra</string>
		<key>PATH</key>
		<string>${xml(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")}</string>
	</dict>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>${schedule.hour}</integer>
		<key>Minute</key>
		<integer>${schedule.minute}</integer>${weekday}
	</dict>
	<key>RunAtLoad</key>
	<false/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>WorkingDirectory</key>
	<string>${xml(settings.paths.projectRoot)}</string>
	<key>StandardOutPath</key>
	<string>${xml(log)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(log)}</string>
</dict>
</plist>
`;
};

const validateScheduleInputs = (settings: LifeOrchestratorSettings, options: LifeScheduleOptions) => {
	if (!isAbsolute(options.launchAgentsDirectory)) {
		throw new LifeOrchestratorError({
			code: "cutover_unsafe",
			message: `LaunchAgents directory is not an absolute path: ${options.launchAgentsDirectory}`,
		});
	}
	for (const [name, path] of [
		["Node", options.nodePath],
		["V2 CLI", options.cliPath],
		["project", settings.paths.projectRoot],
		["compatibility scripts", settings.paths.compatibilityScriptsDirectory],
	] as const) {
		if (!isAbsolute(path) || !existsSync(path)) {
			throw new LifeOrchestratorError({
				code: "cutover_unsafe",
				message: `${name} path is not an existing absolute path: ${path}`,
			});
		}
	}
};

/** Render the exact three V2 Life launch agents; no unrelated scheduler label is in scope. */
export const planLifeSchedule = (
	settings: LifeOrchestratorSettings,
	options: LifeScheduleOptions,
): Effect.Effect<ReadonlyArray<LifeScheduleFile>, LifeOrchestratorError> =>
	Effect.try({
		try: () => {
			validateScheduleInputs(settings, options);
			return LIFE_LAUNCH_AGENT_LABELS.map((label) => ({
				label,
				path: join(resolve(options.launchAgentsDirectory), `${label}.plist`),
				content: renderPlist(label, settings, options),
			}));
		},
		catch: (cause) =>
			cause instanceof LifeOrchestratorError
				? cause
				: new LifeOrchestratorError({
						code: "cutover_unsafe",
						message: "Unable to plan the V2 Life schedule.",
						cause,
					}),
	});

/** Backup the active three plists and atomically install the V2 candidates. Loading remains a separate one-writer gate. */
export const installLifeSchedule = (
	settings: LifeOrchestratorSettings,
	options: LifeScheduleOptions,
): Effect.Effect<LifeScheduleResult, LifeOrchestratorError> =>
	Effect.gen(function* () {
		const files = yield* planLifeSchedule(settings, options);
		return yield* Effect.try({
			try: () => {
				const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
				const backupDirectory = join(settings.paths.stateDirectory, "backups", stamp, "LaunchAgents");
				mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
				mkdirSync(options.launchAgentsDirectory, { recursive: true, mode: 0o700 });
				mkdirSync(join(settings.paths.stateDirectory, "logs"), { recursive: true, mode: 0o700 });
				for (const file of files) {
					if (existsSync(file.path)) {
						writeFileSync(join(backupDirectory, basename(file.path)), readFileSync(file.path), { mode: 0o600 });
					}
					const temporary = `${file.path}.${process.pid}.tmp`;
					writeFileSync(temporary, file.content, { encoding: "utf8", mode: 0o600 });
					renameSync(temporary, file.path);
				}
				writeFileSync(
					join(backupDirectory, "rollback.json"),
					`${JSON.stringify({ createdAt: (options.now ?? new Date()).toISOString(), labels: LIFE_LAUNCH_AGENT_LABELS, files: files.map((file) => file.path) }, null, 2)}\n`,
					{ encoding: "utf8", mode: 0o600 },
				);
				return { applied: true, backupDirectory, files };
			},
			catch: (cause) =>
				cause instanceof LifeOrchestratorError
					? cause
					: new LifeOrchestratorError({
							code: "cutover_unsafe",
							message: "Unable to install the V2 Life schedule.",
							cause,
						}),
		});
	});
