/** Launch the installed sign-in helpers without reading or relaying their credentials. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readCommunityStateRoot, readMeetingPublicationConfig } from "@harnessy/core/read-model";

import type { PortalHandoffService } from "./handoff.ts";

export interface PortalServiceOpenerOptions {
	readonly homeRoot: string;
	readonly workspaceRoot?: string;
	readonly env: NodeJS.ProcessEnv;
	readonly nodePath: string;
	readonly cliPath: string;
}

/** Configured paths are read on each click. The browser cannot choose paths, arguments or executables. */
export const createPortalServiceOpener =
	(options: PortalServiceOpenerOptions) =>
	async (service: PortalHandoffService): Promise<void> => {
		const configPath = join(options.homeRoot, ".jarvis", "config.yaml");
		let args: string[];
		if (service === "cockpit") {
			args = [join(dirname(fileURLToPath(import.meta.resolve("@harnessy/core"))), "cli.js"), "web"];
		} else {
			const config =
				service === "meeting-review"
					? readMeetingPublicationConfig({
							homeRoot: options.homeRoot,
							configPath,
							env: options.env,
							now: new Date(),
						})
					: undefined;
			const statePath =
				service === "community-review"
					? readCommunityStateRoot({ homeRoot: options.homeRoot, configPath })
					: config?.state === "ok"
						? config.data!.statePath
						: null;
			if (statePath === null) throw new Error("service_not_configured");
			args = [
				join(dirname(options.cliPath), `${service}-open-cli${options.cliPath.endsWith(".ts") ? ".ts" : ".js"}`),
				"--state-path",
				statePath,
			];
		}
		await new Promise<void>((resolveOpen, rejectOpen) => {
			const child = spawn(options.nodePath, args, {
				cwd: options.workspaceRoot ?? options.homeRoot,
				env: options.env,
				shell: false,
				stdio: ["ignore", "ignore", "ignore", "ipc"],
				windowsHide: true,
			});
			const timer = setTimeout(
				() => {
					child.kill("SIGTERM");
					rejectOpen(new Error("service_open_timeout"));
				},
				service === "cockpit" ? 45_000 : 10_000,
			);
			child.once("error", () => {
				clearTimeout(timer);
				rejectOpen(new Error("service_open_failed"));
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				if (service === "cockpit" && code === 0) resolveOpen();
				else rejectOpen(new Error("service_open_failed"));
			});
			child.once("message", (message: unknown) => {
				if (
					typeof message !== "object" ||
					message === null ||
					!("kind" in message) ||
					message.kind !== "review_opened"
				)
					return;
				clearTimeout(timer);
				// The helper keeps its exchange file alive until redemption or its bounded cleanup deadline.
				child.disconnect();
				resolveOpen();
			});
		});
	};
