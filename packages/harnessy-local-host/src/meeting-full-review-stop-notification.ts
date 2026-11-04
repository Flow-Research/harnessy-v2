import { type ExecFileOptions, execFile } from "node:child_process";

type LocalNotificationProcess = (
	file: string,
	args: ReadonlyArray<string>,
	options: ExecFileOptions,
	completed: (error: Error | null) => void,
) => void;

/**
 * Explicit operator opt-in, independent of expired dispatch authority. No
 * configuration executable, credential, meeting text or error enters this call.
 * Internal process injection exists only for isolated subprocess tests.
 */
export const notifyMeetingFullReviewStopped = (
	platform: string = process.platform,
	run: LocalNotificationProcess = execFile,
	workflow: "meeting" | "community" = "meeting",
): Promise<boolean> => {
	if (platform !== "darwin") return Promise.resolve(false);
	return new Promise<boolean>((resolve) => {
		run(
			"/usr/bin/osascript",
			[
				"-e",
				workflow === "meeting"
					? 'display notification "Meeting review and dispatch stopped. Do not retry uncertain deliveries. Check the session log and reconcile before restarting." with title "Harnessy meeting runtime stopped"'
					: 'display notification "Community publication stopped. Do not retry uncertain deliveries. Check the session log and reconcile before restarting." with title "Harnessy community publication stopped"',
			],
			{
				shell: false,
				timeout: 2_000,
				killSignal: "SIGKILL",
				maxBuffer: 1_024,
				windowsHide: true,
				env: { PATH: "/usr/bin:/bin" },
			},
			(error) => resolve(error === null),
		);
	}).catch(() => false);
};
