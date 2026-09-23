import { type ExecFileOptions, execFile } from "node:child_process";

type NotificationProcess = (
	file: string,
	args: ReadonlyArray<string>,
	options: ExecFileOptions,
	completed: (error: Error | null) => void,
) => void;

/** Same bounded macOS fallback used by the local host. No draft text, paths,
 * credentials or provider errors enter the desktop message. The process seam
 * is for isolated OS-boundary tests, never configurable through the CLI.
 */
export const notifyCommunityDraft = (
	kind: "pending" | "error",
	count: number,
	signal: AbortSignal,
	platform: string = process.platform,
	run: NotificationProcess = execFile,
): Promise<boolean> => {
	if (platform !== "darwin" || signal.aborted || !Number.isSafeInteger(count) || count < 0 || count > 10000)
		return Promise.resolve(false);
	const message =
		kind === "pending"
			? `${count} weekly briefing drafts waiting for local review.`
			: "Community generation needs attention. Inspect the local run record before retrying.";
	return new Promise<boolean>((resolve) => {
		run(
			"/usr/bin/osascript",
			["-e", `display notification "${message}" with title "Harnessy community briefing"`],
			{
				shell: false,
				timeout: 2000,
				killSignal: "SIGKILL",
				maxBuffer: 1024,
				windowsHide: true,
				signal,
				env: { PATH: "/usr/bin:/bin" },
			},
			(error) => resolve(error === null),
		);
	}).catch(() => false);
};
