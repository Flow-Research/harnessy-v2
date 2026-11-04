import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PortalServiceOpenerOptions } from "./open-service.ts";

export interface BriefGenerationStatus {
	readonly state: "idle" | "running" | "succeeded" | "failed";
	readonly message: string;
}

/** One fixed Jarvis operation; Core also holds the cross-process daily-run lock. */
export const createBriefGeneration = (run: () => Promise<void>) => {
	let status: BriefGenerationStatus = { state: "idle", message: "" };
	return {
		status: () => status,
		start: () => {
			if (status.state === "running") return status;
			status = { state: "running", message: "Generating today’s brief. You can leave this page and come back." };
			void Promise.resolve()
				.then(run)
				.then(
					() => {
						status = { state: "succeeded", message: "Today’s brief is ready." };
					},
					(error: unknown) => {
						status = {
							state: "failed",
							message:
								error instanceof Error && error.message === "brief_timeout"
									? "Generation timed out. Check today’s brief and try again."
									: "Generation failed or another daily run is active. Try again after the Daily brief job finishes.",
						};
					},
				);
			return status;
		},
	};
};

export const createInstalledBriefGeneration = (options: PortalServiceOpenerOptions) =>
	createBriefGeneration(
		() =>
			new Promise<void>((resolve, reject) => {
				const cli = join(dirname(fileURLToPath(import.meta.resolve("@harnessy/core"))), "cli.js");
				const scheduler = join(
					options.homeRoot,
					"Library/LaunchAgents/com.flow-harness.life-orchestrator.daily-brief.plist",
				);
				let environment = options.env;
				if (process.platform === "darwin" && existsSync(scheduler)) {
					const configured: unknown = JSON.parse(
						execFileSync("/usr/bin/plutil", ["-extract", "EnvironmentVariables", "json", "-o", "-", scheduler], {
							encoding: "utf8",
							timeout: 3000,
							maxBuffer: 65536,
						}),
					);
					if (
						typeof configured !== "object" ||
						configured === null ||
						Array.isArray(configured) ||
						!Object.values(configured).every((value) => typeof value === "string")
					)
						throw new Error("brief_configuration_invalid");
					environment = { ...options.env, ...configured };
				}
				const child = spawn(
					options.nodePath,
					[
						cli,
						"jarvis",
						"life",
						"daily",
						"--force",
						"--max-output-bytes",
						"1048576",
						"--target",
						options.workspaceRoot ?? options.homeRoot,
						"--home-root",
						options.homeRoot,
					],
					{
						cwd: options.workspaceRoot ?? options.homeRoot,
						env: { ...environment, LIFE_ORCHESTRATOR_DAILY_AI_TIMEOUT: "1200" },
						stdio: ["ignore", "ignore", "pipe"],
						shell: false,
					},
				);
				let diagnostic = "";
				child.stderr?.on("data", (chunk: Buffer) => {
					diagnostic = (diagnostic + chunk.toString("utf8")).slice(-8192);
				});
				const timer = setTimeout(() => {
					child.kill("SIGTERM");
					reject(new Error("brief_timeout"));
				}, 25 * 60_000);
				child.once("error", () => {
					clearTimeout(timer);
					reject(new Error("brief_failed"));
				});
				child.once("exit", (code) => {
					clearTimeout(timer);
					if (code === 0) resolve();
					else reject(new Error(/timed out|timeout/iu.test(diagnostic) ? "brief_timeout" : "brief_failed"));
				});
			}),
	);
