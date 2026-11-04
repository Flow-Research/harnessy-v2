/**
 * Process glue for the `harnessy-portal` bin: opening the browser and stopping
 * on a signal. Kept apart from `portal-cli.ts` so both can be tested without
 * signalling the test runner.
 */
import { spawn } from "node:child_process";

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
