import { isAbsolute, join } from "node:path";

export const CALENDAR_IMPORT_LAUNCH_AGENT_LABEL = "com.flow-harness.calendar-import" as const;
/** Thirty minutes keeps observations well inside the provider's two-hour freshness limit. */
export const CALENDAR_IMPORT_INTERVAL_SECONDS = 30 * 60;

export interface CalendarImportScheduleOptions {
	readonly nodePath: string;
	readonly cliPath: string;
	readonly googleExecutable: string;
	readonly home: string;
}

const xml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");

/**
 * The launchd job definition. This module only renders text: it never writes a
 * LaunchAgents file and never calls launchctl. Installing it is a separate,
 * human step after merge (`scripts/install-calendar-import-launchd.sh`).
 */
export function renderCalendarImportPlist(options: CalendarImportScheduleOptions): string {
	for (const [label, value] of [
		["Node", options.nodePath],
		["CLI", options.cliPath],
		["Google executable", options.googleExecutable],
		["home", options.home],
	] as const)
		if (!isAbsolute(value)) throw new Error(`${label} path must be absolute`);
	const log = join(options.home, ".harnessy", "logs", `${CALENDAR_IMPORT_LAUNCH_AGENT_LABEL}.log`);
	const argumentsList = [
		options.nodePath,
		options.cliPath,
		"jarvis",
		"calendar",
		"import",
		"--google-executable",
		options.googleExecutable,
	];
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xml(CALENDAR_IMPORT_LAUNCH_AGENT_LABEL)}</string>
	<key>ProgramArguments</key>
	<array>
${argumentsList.map((argument) => `\t\t<string>${xml(argument)}</string>`).join("\n")}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>${xml(options.home)}</string>
		<key>PATH</key>
		<string>/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>StartInterval</key>
	<integer>${CALENDAR_IMPORT_INTERVAL_SECONDS}</integer>
	<key>RunAtLoad</key>
	<false/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>Umask</key>
	<integer>63</integer>
	<key>StandardOutPath</key>
	<string>${xml(log)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(log)}</string>
</dict>
</plist>
`;
}
