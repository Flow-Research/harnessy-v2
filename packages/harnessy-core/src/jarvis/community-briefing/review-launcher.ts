import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import * as Effect from "effect/Effect";

export interface CommunityReviewLaunchOptions {
	readonly executable: string;
	readonly port: number;
}

export const communityReviewArguments = (port: number): ReadonlyArray<string> => [
	"community",
	"briefing",
	"review",
	"serve",
	"--port",
	String(port),
];

/** Launch the preserved review writer only from an explicitly supplied executable. */
export const launchCommunityReviewCompatibility = (
	options: CommunityReviewLaunchOptions,
): Effect.Effect<void, Error> =>
	!isAbsolute(options.executable)
		? Effect.fail(new Error("community review compatibility executable must be an absolute path"))
		: !Number.isInteger(options.port) || options.port < 1 || options.port > 65_535
			? Effect.fail(new Error("community review port must be between 1 and 65535"))
			: Effect.promise(
					() =>
						new Promise<void>((resolve, reject) => {
							const child = spawn(options.executable, communityReviewArguments(options.port), {
								stdio: "inherit",
								windowsHide: true,
							});
							child.once("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
							child.once("exit", (code, signal) => {
								if (code === 0) resolve();
								else reject(new Error(`community review exited ${signal ?? code ?? "unknown"}`));
							});
						}),
				);
