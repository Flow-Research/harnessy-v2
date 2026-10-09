import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Console } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { Argument, Command, Flag } from "effect/unstable/cli";

/** Host is optional and resolved only when this domain is invoked; Core never imports it. */
export const runWikiHost = (args: readonly string[]): Promise<string> =>
	new Promise((resolve, reject) => {
		const resolved = Result.try(() => createRequire(import.meta.url).resolve("@harnessy/local-host/wiki-cli"));
		if (Result.isFailure(resolved)) {
			reject(new Error("Personal knowledge requires the V2 @harnessy/local-host package in this installation."));
			return;
		}
		const entry = resolved.success;
		const child = spawn(process.execPath, [entry, ...args], {
			stdio: args[0] === "open" ? "inherit" : ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let truncated = false;
		const stop = () => child.kill("SIGTERM");
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.length > 2_000_000 && !truncated) {
				truncated = true;
				child.kill();
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-8000);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			process.removeListener("SIGINT", stop);
			process.removeListener("SIGTERM", stop);
			if (truncated) reject(new Error("Wiki host output exceeded the 2,000,000-character limit"));
			else if (code === 0) resolve(stdout);
			else reject(new Error(stderr || `Wiki host exited ${code}`));
		});
	});

const common = {
	json: Flag.boolean("json"),
	home: Flag.string("home-root").pipe(Flag.optional),
	vault: Flag.string("vault").pipe(Flag.optional),
	target: Flag.string("target").pipe(Flag.optional),
};
const baseArgs = (value: {
	home: Option.Option<string>;
	vault: Option.Option<string>;
	target: Option.Option<string>;
}): string[] => [
	"--json",
	...(
		[
			["home-root", value.home],
			["vault", value.vault],
			["target", value.target],
		] as const
	).flatMap(([key, option]) => (Option.isSome(option) ? [`--${key}`, option.value] : [])),
];
const invoke = (args: string[]) =>
	Effect.tryPromise({ try: () => runWikiHost(args), catch: (error) => new Error(String(error)) }).pipe(
		Effect.flatMap((value) => Console.log(value.trimEnd())),
	);

export const wikiCommand = Command.make("wiki").pipe(
	Command.withSubcommands([
		Command.make(
			"ingest",
			{
				...common,
				source: Argument.string("source"),
				topic: Flag.string("topic").pipe(Flag.between(0, 12)),
				note: Flag.string("note").pipe(Flag.optional),
			},
			(value) =>
				invoke([
					"ingest",
					value.source,
					...baseArgs(value),
					...value.topic.flatMap((topic) => ["--topic", topic]),
					...(Option.isSome(value.note) ? ["--note", value.note.value] : []),
				]),
		),
		Command.make(
			"sync",
			{ ...common, refresh: Flag.boolean("refresh"), captureOnly: Flag.boolean("capture-only") },
			(value) =>
				invoke([
					"sync",
					...baseArgs(value),
					...(value.refresh ? ["--refresh"] : []),
					...(value.captureOnly ? ["--capture-only"] : []),
				]),
		),
		Command.make("search", { ...common, query: Argument.string("query") }, (value) =>
			invoke(["search", value.query, ...baseArgs(value)]),
		),
		Command.make(
			"ask",
			{ ...common, question: Argument.string("question"), context: Flag.boolean("context") },
			(value) => invoke(["ask", value.question, ...baseArgs(value), ...(value.context ? ["--context"] : [])]),
		),
		Command.make("status", common, (value) => invoke(["status", ...baseArgs(value)])),
		Command.make("review", { ...common, week: Flag.string("week").pipe(Flag.optional) }, (value) =>
			invoke(["review", ...(Option.isSome(value.week) ? ["--week", value.week.value] : []), ...baseArgs(value)]),
		),
		Command.make("open", common, (value) => invoke(["open", ...baseArgs(value)])),
	] as const),
	Command.withDescription("Capture, maintain and query a private personal learning library"),
);
