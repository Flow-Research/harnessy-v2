import type { ProcessProbeResult, ProcessProbeRunner } from "../../src/jarvis/writer-check.ts";

/**
 * Scripted OS answers for the one-writer guards. No real process is spawned.
 * - clear: no writer process; no launchd job; no crontab
 * - timeout: every probe times out (spawnSync ETIMEDOUT)
 * - launchctl_error: launchctl fails with exit 5 and no "Could not find service"
 * - writer: a same-user V1 meeting writer process is running (its argv carries a secret)
 * - loaded_job: every guarded launchd job is loaded
 */
export type ScriptedProbeMode = "clear" | "timeout" | "launchctl_error" | "writer" | "loaded_job";

export const SCRIPTED_WRITER_ARGV_SECRET = "SECRET-ARGV-TOKEN";

export const makeScriptedProbeRunner = (initial: ScriptedProbeMode = "clear") => {
	let mode = initial;
	const commands: Array<string> = [];
	const uid = process.geteuid?.() ?? 0;
	const answer = (status: number | null, stdout = "", stderr = ""): ProcessProbeResult => ({
		status,
		signal: null,
		stdout,
		stderr,
	});
	const run: ProcessProbeRunner = (command) => {
		commands.push(command);
		if (mode === "timeout")
			return {
				status: null,
				signal: "SIGTERM",
				error: Object.assign(new Error(`spawnSync ${command} ETIMEDOUT`), { code: "ETIMEDOUT" }),
				stdout: "",
				stderr: "",
			};
		if (command === "/bin/ps")
			return answer(
				0,
				mode === "writer"
					? `${uid} 4242 jarvis meeting publish worker --token ${SCRIPTED_WRITER_ARGV_SECRET}\n`
					: `${uid} 4242 /usr/bin/true --idle\n`,
			);
		if (command === "/bin/launchctl") {
			if (mode === "loaded_job") return answer(0, "state = running\n");
			if (mode === "launchctl_error") return answer(5, "", "Bootstrap failed: 5: Input/output error\n");
			return answer(113, "", "Could not find service in domain for user gui\n");
		}
		if (command === "/usr/bin/crontab") return answer(1, "", "crontab: no crontab for fixture\n");
		throw new Error("unexpected OS command");
	};
	return {
		run,
		commands,
		setMode: (next: ScriptedProbeMode) => {
			mode = next;
		},
	};
};
