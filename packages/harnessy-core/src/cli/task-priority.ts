import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { z } from "zod";
import { priorityEvidence } from "../jarvis/tasks/priority-evidence.ts";
import {
	finishPriorityRun,
	formatPriorityTable,
	localPriorityWriter,
	rankSnapshot,
	readPriorityStore,
} from "../jarvis/tasks/priority-shadow.ts";
import { defaultTasksFile } from "../jarvis/tasks/store.ts";

export const taskPriorityCommand = Command.make(
	"priority",
	{
		tasksFile: Flag.String("tasks-file").pipe(Flag.optional),
		evidence: Flag.String("evidence").pipe(Flag.optional),
		at: Flag.String("at").pipe(Flag.optional),
		shadow: Flag.Boolean("shadow").pipe(Flag.withDefault(false)),
		json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
		apply: Flag.Boolean("apply").pipe(Flag.withDefault(false)),
		confirm: Flag.String("confirm").pipe(Flag.optional),
	},
	(flags) =>
		Effect.tryPromise(async () => {
			if (flags.shadow && flags.apply) throw new Error("Choose either shadow or apply");
			const cache = defaultTasksFile(homedir());
			const file = resolve(Option.getOrElse(flags.tasksFile, () => cache));
			const evidenceFile = Option.getOrUndefined(flags.evidence);
			const evidence = evidenceFile
				? priorityEvidence.parse(JSON.parse(readFileSync(evidenceFile, "utf8")))
				: { version: 1 as const, tasks: [] };
			const instant = Option.getOrUndefined(flags.at);
			const at = instant === undefined ? new Date() : new Date(z.iso.datetime({ offset: true }).parse(instant));
			const store = readPriorityStore(file);
			const snapshot = await rankSnapshot(store, evidence, at);
			if (
				flags.apply &&
				(!evidenceFile || Option.isNone(flags.tasksFile) || realpathSync(file) === resolve(cache))
			) {
				throw new Error("Apply requires evidence and an explicit standalone task store");
			}
			if (flags.apply) {
				const ids = new Set(evidence.tasks.map((task) => task.taskId.toLowerCase()));
				if (
					store.items.some(
						(task) => task.status !== "done" && task.status !== "dropped" && !ids.has(task.id.toLowerCase()),
					)
				) {
					throw new Error("Apply requires reviewed evidence for every open task");
				}
			}
			finishPriorityRun(snapshot, flags.apply, Option.getOrUndefined(flags.confirm), localPriorityWriter(file));
			return flags.json ? JSON.stringify(snapshot, null, 2) : formatPriorityTable(snapshot);
		}).pipe(Effect.flatMap(Console.log)),
).pipe(
	Command.withDescription(
		"Preview action priorities from a local task store. Calendar and mail are offline by default. To update a standalone store, supply --apply and --confirm with its preview snapshot ID.",
	),
);
