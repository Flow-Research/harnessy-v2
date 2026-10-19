import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { Command, Flag } from "effect/unstable/cli";

/** Where `harnessy portal` finds the host, and which process signals it forwards. Tests pass their own. */
export interface PortalHostRuntime {
	/** The host script path. Throws when the host package is not installed. */
	readonly resolveHost?: () => string;
	readonly signals?: Pick<NodeJS.EventEmitter, "once" | "removeListener">;
}

const resolveInstalledHost = (): string => createRequire(import.meta.url).resolve("@harnessy/local-host/portal-cli");

/**
 * Run the read-only portal host (`@harnessy/local-host/portal-cli`). Core never imports the host;
 * it is resolved only when this command runs. The child's argv is
 * `node <portal-cli.js> <subcommand> …`, which matches neither one-writer guard.
 */
export const runPortalHost = (args: ReadonlyArray<string>, runtime: PortalHostRuntime = {}): Promise<number> =>
	new Promise((resolve, reject) => {
		const resolved = Result.try(runtime.resolveHost ?? resolveInstalledHost);
		if (Result.isFailure(resolved)) {
			reject(new Error("The portal requires the V2 @harnessy/local-host package in this installation."));
			return;
		}
		const signals = runtime.signals ?? process;
		const child = spawn(process.execPath, [resolved.success, ...args], { stdio: "inherit" });
		const stop = () => child.kill("SIGTERM");
		signals.once("SIGINT", stop);
		signals.once("SIGTERM", stop);
		child.on("error", reject);
		child.on("close", (code) => {
			signals.removeListener("SIGINT", stop);
			signals.removeListener("SIGTERM", stop);
			resolve(code ?? 1);
		});
	});

/** The host argv for one portal subcommand. Only set options are passed on. */
export const portalHostArgs = (
	subcommand: "serve" | "status" | "open" | "service-plan",
	options: Readonly<Record<string, Option.Option<string> | boolean>>,
): string[] => [
	subcommand,
	...Object.entries(options).flatMap(([name, value]) => {
		if (typeof value === "boolean") return value ? [`--${name}`] : [];
		return Option.isSome(value) ? [`--${name}`, value.value] : [];
	}),
];

const invoke = (args: string[]) =>
	Effect.tryPromise({ try: () => runPortalHost(args), catch: (error) => new Error(String(error)) }).pipe(
		Effect.flatMap((code) => (code === 0 ? Effect.void : Effect.fail(new Error(`Portal host exited ${code}`)))),
	);

const port = Flag.string("port").pipe(Flag.optional);
const stateDir = Flag.string("state-dir").pipe(Flag.optional);
const route = Flag.string("route").pipe(
	Flag.withDescription("Screen to open: inbox, today, tasks, jobs, reviews, learning or connections"),
	Flag.optional,
);
const print = Flag.boolean("print").pipe(Flag.withDescription("Print the sign-in link instead of opening it"));

const openHandler = (value: {
	readonly port: Option.Option<string>;
	readonly stateDir: Option.Option<string>;
	readonly route: Option.Option<string>;
	readonly print: boolean;
}) =>
	invoke(
		portalHostArgs("open", {
			port: value.port,
			"state-dir": value.stateDir,
			route: value.route,
			print: value.print,
		}),
	);

/** `harnessy open`: the one front door. The same as `harnessy portal open`. */
export const openCommand = Command.make("open", { port, stateDir, route, print }, openHandler).pipe(
	Command.withDescription("Open Harnessy, the one local app, with a one-time sign-in code"),
);

export const portalCommand = Command.make("portal").pipe(
	Command.withSubcommands([
		Command.make(
			"serve",
			{
				port,
				stateDir,
				homeRoot: Flag.string("home-root").pipe(Flag.optional),
				workspaceRoot: Flag.string("workspace-root").pipe(Flag.optional),
			},
			(value) =>
				invoke(
					portalHostArgs("serve", {
						port: value.port,
						"state-dir": value.stateDir,
						"home-root": value.homeRoot,
						"workspace-root": value.workspaceRoot,
					}),
				),
		).pipe(Command.withDescription("Serve the read-only portal API on 127.0.0.1")),
		Command.make("status", { port, stateDir }, (value) =>
			invoke(portalHostArgs("status", { port: value.port, "state-dir": value.stateDir })),
		).pipe(Command.withDescription("Show the portal's version and service health")),
		Command.make("open", { port, stateDir, route, print }, openHandler).pipe(
			Command.withDescription("Open Harnessy with a one-time sign-in code (same as `harnessy open`)"),
		),
		Command.make("service-plan", { port, stateDir }, (value) =>
			invoke(portalHostArgs("service-plan", { port: value.port, "state-dir": value.stateDir })),
		).pipe(Command.withDescription("Print the planned LaunchAgent; installs nothing")),
	] as const),
	Command.withDescription("The Harnessy app server on 127.0.0.1:8790: read-only Inbox, Today, Tasks, Jobs and more"),
);
