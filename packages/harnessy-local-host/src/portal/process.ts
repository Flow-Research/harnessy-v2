/**
 * Process glue for the `harnessy-portal` bin: opening the browser and stopping
 * on a signal. Kept apart from `portal-cli.ts` so both can be tested without
 * signalling the test runner.
 */
import { spawn } from "node:child_process";
import { dirname } from "node:path";

/** The system command that opens a URL in the default browser. */
export const systemOpener = (platform: NodeJS.Platform): string =>
	platform === "darwin" ? "/usr/bin/open" : "xdg-open";

/**
 * Start `opener url` detached. When the opener cannot start (for example, no
 * `xdg-open` on a Linux server), `onFailure` runs instead of an uncaught
 * `error` event crashing the process.
 */
export const launchOpener = (opener: string, url: string, onFailure: () => void): void => {
	const child = spawn(opener, [url], { shell: false, stdio: "ignore", detached: true });
	child.once("error", () => onFailure());
	child.unref();
};

/** Start `opener ...args` detached; resolves once it started, rejects when it could not start. */
export const startOpener = (opener: string, args: readonly string[]): Promise<void> =>
	new Promise((resolve, reject) => {
		const child = spawn(opener, [...args], { shell: false, stdio: "ignore", detached: true });
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
		child.once("error", reject);
	});

/**
 * The opener arguments for a saved file link. `reveal` shows the file in the file manager
 * without opening it: `open -R` on macOS; elsewhere the folder that holds it is opened.
 */
export const fileOpenerArgs = (platform: NodeJS.Platform, path: string, reveal: boolean): string[] =>
	!reveal ? [path] : platform === "darwin" ? ["-R", path] : [dirname(path)];

export interface SignalIo {
	readonly once: (signal: "SIGTERM" | "SIGINT", listener: () => void) => void;
	readonly exit: (code: number) => void;
}

/**
 * Close the server on the first SIGTERM or SIGINT, once only, then exit 0 after
 * a clean close or 1 when closing fails. A second signal during shutdown is ignored.
 */
export const stopOnSignals = (close: () => Promise<void>, io: SignalIo): void => {
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		close().then(
			() => io.exit(0),
			() => io.exit(1),
		);
	};
	io.once("SIGTERM", stop);
	io.once("SIGINT", stop);
};
