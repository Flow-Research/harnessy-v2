import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { causeMessage, HarnessError } from "../errors.ts";
import {
	executeWorkspaceRelocation,
	planWorkspaceRelocation,
	type RelocationBackup,
	type RelocationPlan,
} from "../workspace-relocation.ts";
import {
	applyWorkspaceStateMigration,
	planWorkspaceStateMigration,
	type WorkspaceStateMigration,
} from "../workspace-state-migration.ts";

const readDocument = (path: string): unknown => {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304)
		throw new Error("Expected a regular migration document below 4 MiB");
	return JSON.parse(readFileSync(path, "utf8"));
};
const writeDocument = (path: string, value: unknown): string => {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600, flush: true });
	return resolve(path);
};
const operation = (run: () => unknown) =>
	Effect.try({ try: run, catch: (cause) => new HarnessError({ message: causeMessage(cause), cause }) }).pipe(
		Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))),
	);
const plan = Command.make(
	"plan",
	{
		root: Flag.string("root"),
		moves: Flag.string("moves"),
		output: Flag.string("output"),
	},
	({ root, moves, output }) =>
		operation(() => {
			const input = readDocument(moves);
			if (
				!Array.isArray(input) ||
				!input.every(
					(entry) =>
						entry !== null &&
						typeof entry === "object" &&
						typeof entry.from === "string" &&
						typeof entry.to === "string",
				)
			)
				throw new Error("Moves must be an array of {from,to} relative paths");
			const result = planWorkspaceRelocation(root, input as Array<{ from: string; to: string }>);
			return { planPath: writeDocument(output, result), moves: result.moves.length, id: result.id };
		}),
);
const apply = Command.make(
	"apply",
	{
		plan: Flag.string("plan"),
		backups: Flag.string("backups"),
	},
	({ plan, backups }) =>
		operation(() => {
			const input = readDocument(backups);
			if (
				!Array.isArray(input) ||
				!input.every(
					(entry) =>
						entry !== null &&
						typeof entry === "object" &&
						typeof entry.from === "string" &&
						typeof entry.backupPath === "string",
				)
			)
				throw new Error("Backups must be an array of {from,backupPath}");
			return {
				journalPath: executeWorkspaceRelocation(readDocument(plan) as RelocationPlan, input as RelocationBackup[]),
			};
		}),
);
const rollback = Command.make("rollback", { plan: Flag.string("plan") }, ({ plan }) =>
	operation(() => ({ journalPath: executeWorkspaceRelocation(readDocument(plan) as RelocationPlan, [], true) })),
);
const statePlan = Command.make(
	"state-plan",
	{
		database: Flag.string("database"),
		kind: Flag.choice("kind", ["meeting", "community"]),
		from: Flag.string("from"),
		to: Flag.string("to"),
		output: Flag.string("output"),
	},
	({ database, kind, from, to, output }) =>
		operation(() => {
			const result = planWorkspaceStateMigration(database, kind, from, to);
			return { planPath: writeDocument(output, result), changedPaths: result.changes.length };
		}),
);
const stateApply = Command.make(
	"state-apply",
	{
		plan: Flag.string("plan"),
		backup: Flag.string("backup"),
		rollback: Flag.boolean("rollback"),
	},
	({ plan, backup, rollback }) =>
		operation(() => applyWorkspaceStateMigration(readDocument(plan) as WorkspaceStateMigration, backup, rollback)),
);
export const workspaceMigrationCommand = Command.make("migrate").pipe(
	Command.withSubcommands([plan, apply, rollback, statePlan, stateApply]),
	Command.withDescription("Offline, backup-verified relocation; stop affected writers before applying"),
);
