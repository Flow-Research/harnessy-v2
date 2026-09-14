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
): Promise<boolean> => {
	if (platform !== "darwin") return Promise.resolve(false);
	return new Promise<boolean>((resolve) => {
		run(
			"/usr/bin/osascript",
			[
				"-e",
				'display notification "Meeting review and dispatch stopped. Do not retry uncertain deliveries. Check the session log and reconcile before restarting." with title "Harnessy meeting runtime stopped"',
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
