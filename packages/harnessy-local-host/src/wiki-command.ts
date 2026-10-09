import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { localWikiExecutor } from "./wiki/model.ts";
import {
	askWiki,
	isoWeek,
	isoWeekMonday,
	queryContext,
	reviewWiki,
	statusWiki,
	syncWiki,
	weeklyCompanionPath,
} from "./wiki/service.ts";
import { WikiStore } from "./wiki/store.ts";

export async function runWikiCommand(args: readonly string[]): Promise<unknown> {
	const { values, positionals } = parseArgs({
		args: [...args],
		allowPositionals: true,
		strict: true,
		options: {
			json: { type: "boolean" },
			"home-root": { type: "string" },
			vault: { type: "string" },
			target: { type: "string" },
			topic: { type: "string", multiple: true },
			note: { type: "string" },
			week: { type: "string" },
			refresh: { type: "boolean" },
			"capture-only": { type: "boolean" },
			"life-companion": { type: "boolean" },
			context: { type: "boolean" },
			help: { type: "boolean" },
		},
	});
	const [command, argument, ...extra] = positionals;
	if (values.help || !command)
		return {
			usage: "harnessy jarvis wiki ingest <url|file> [--topic label] [--note text] | sync [--refresh] [--capture-only] | search <query> | ask <question> [--context] | status | review --week YYYY-Www | open",
			output:
				"All commands return structured JSON. --context retrieves evidence for the current agent without a model call.",
		};
	if (extra.length || !["ingest", "sync", "search", "ask", "status", "review", "open"].includes(command))
		throw new Error("Invalid wiki command or extra arguments");
	if (["ingest", "search", "ask"].includes(command) !== Boolean(argument))
		throw new Error("Expected exactly one quoted source/query argument for ingest, search or ask");
	const homeRoot = resolve(values["home-root"] ?? homedir());
	const root = resolve(values.vault ?? join(homeRoot, ".harnessy", "jarvis", "wiki", "learning"));
	if (command === "open") {
		// Public viewer entrypoint only; never run OpenWiki ingestion or integration setup.
		await new Promise<void>((done, reject) => {
			const child = spawn(
				"npx",
				["--yes", "--ignore-scripts", "--package=openwiki@0.5.1", "openwiki", "visualize", join(root, "wiki")],
				{
					stdio: "inherit",
					detached: process.platform !== "win32",
					// The library is private: opt the viewer out of OpenWiki's usage telemetry.
					env: { ...process.env, OPENWIKI_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
				},
			);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const signalViewer = (signal: NodeJS.Signals) => {
				if (!child.pid) return;
				try {
					if (process.platform === "win32") child.kill(signal);
					else process.kill(-child.pid, signal);
				} catch {
					/* Already exited. */
				}
			};
			const stop = () => {
				signalViewer("SIGTERM");
				timer ??= setTimeout(() => signalViewer("SIGKILL"), 5000);
			};
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
			child.on("error", reject);
			child.on("close", (code) => {
				if (timer) clearTimeout(timer);
				process.removeListener("SIGINT", stop);
				process.removeListener("SIGTERM", stop);
				if (code === 0 || code === null || timer) done();
				else reject(new Error(`Viewer exited ${code}`));
			});
		});
		return { closed: true };
	}
	const readOnly = ["ask", "search", "status"].includes(command);
	if (readOnly && !existsSync(join(root, "catalog.sqlite3")))
		return {
			captured: 0,
			sources: [],
			passages: [],
			pages: [],
			answer: "The library has no supporting evidence yet.",
			evidenceGap: true,
		};
	const store = new WikiStore(root, readOnly);
	const execute = localWikiExecutor();
	try {
		if (command === "ingest")
			return await store.write(async () => ({
				source: store.capture({
					uri: argument as string,
					topics: values.topic,
					note: values.note,
					manual: true,
					kind: "saved",
					event: `manual:${randomUUID()}`,
					occurredAt: new Date().toISOString(),
				}),
			}));
		if (command === "status") return statusWiki(store);
		if (command === "search") return store.search(argument as string);
		if (command === "ask")
			return values.context
				? queryContext(store, argument as string)
				: await askWiki(store, execute, argument as string);
		if (command === "review") {
			const week = values.week ?? isoWeek(new Date());
			const result = await reviewWiki(store, execute, week);
			if (values["life-companion"]) {
				const companion = weeklyCompanionPath(join(homeRoot, ".agents", "life"), isoWeekMonday(week));
				const link = relative(dirname(companion), join(root, "wiki", "reviews", `${week}.md`))
					.split("\\")
					.join("/");
				const content = `# Learning review ${week}\n\n[Read the dated learning review](${link})\n`;
				if (existsSync(companion) && readFileSync(companion, "utf8") !== content)
					throw new Error("Personal edit conflict in weekly review companion");
				if (!existsSync(companion)) {
					mkdirSync(dirname(companion), { recursive: true, mode: 0o700 });
					const temp = `${companion}.${randomUUID()}.tmp`;
					writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
					renameSync(temp, companion);
				}
				return { ...result, companion };
			}
			return result;
		}
		return await syncWiki(store, execute, {
			homeRoot,
			projectRoot: resolve(values.target ?? process.cwd()),
			refresh: values.refresh,
			captureOnly: values["capture-only"],
		});
	} finally {
		store.close();
	}
}
