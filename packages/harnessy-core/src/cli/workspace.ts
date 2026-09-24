import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { causeMessage, HarnessError } from "../errors.ts";
import { initializeWorkspace, inspectWorkspace, registerWorkspaceProject, resolveWorkspace } from "../workspace.ts";
import { workspaceMigrationCommand } from "./workspace-migration.ts";

const canonicalPath = (input: string): string => {
	let ancestor = resolve(input);
	const suffix: string[] = [];
	while (!existsSync(ancestor)) {
		suffix.unshift(basename(ancestor));
		const parent = dirname(ancestor);
		if (parent === ancestor) throw new Error(`Cannot resolve path: ${input}`);
		ancestor = parent;
	}
	return join(realpathSync(ancestor), ...suffix);
};

const workspaceEffect = <A>(run: () => A) =>
	Effect.try({ try: run, catch: (cause) => new HarnessError({ message: causeMessage(cause), cause }) });

const rootFlag = Flag.string("workspace-root").pipe(Flag.optional);
const jsonFlag = Flag.boolean("json");

const requireWorkspace = (root: Option.Option<string>) => {
	const workspace = resolveWorkspace({ workspaceRoot: Option.getOrUndefined(root) });
	if (!workspace) throw new Error("No workspace found. Run harnessy workspace init <root> first.");
	return workspace;
};

const init = Command.make("init", { root: Argument.string("root"), json: jsonFlag }, ({ root }) =>
	workspaceEffect(() => initializeWorkspace(resolve(root))).pipe(
		Effect.flatMap((value) => Console.log(JSON.stringify(value, null, 2))),
	),
);

const add = Command.make(
	"add",
	{
		path: Argument.string("path"),
		id: Flag.string("id"),
		root: rootFlag,
		contextDir: Flag.string("context-dir").pipe(Flag.withDefault(".jarvis/context")),
		worktreesDir: Flag.string("worktrees-dir").pipe(Flag.optional),
		branch: Flag.string("integration-branch").pipe(Flag.optional),
		json: jsonFlag,
	},
	({ path, id, root, contextDir, worktreesDir, branch }) =>
		workspaceEffect(() => {
			const workspace = requireWorkspace(root);
			return registerWorkspaceProject(workspace.root, {
				id,
				path: relative(workspace.root, canonicalPath(path)).split(sep).join("/"),
				contextDir,
				...(Option.isSome(worktreesDir)
					? { worktreesDir: relative(workspace.root, canonicalPath(worktreesDir.value)).split(sep).join("/") }
					: {}),
				...(Option.isSome(branch) ? { integrationBranch: branch.value } : {}),
			});
		}).pipe(Effect.flatMap((value) => Console.log(JSON.stringify(value, null, 2)))),
);

const list = Command.make("list", { root: rootFlag, json: jsonFlag }, ({ root, json }) =>
	workspaceEffect(() => requireWorkspace(root)).pipe(
		Effect.flatMap((value) =>
			Console.log(
				json
					? JSON.stringify(value, null, 2)
					: value.manifest.projects.map((project) => `${project.id}\t${project.path}`).join("\n"),
			),
		),
	),
);

const doctor = Command.make("doctor", { root: rootFlag, json: jsonFlag }, ({ root, json }) =>
	Effect.gen(function* () {
		const workspace = yield* workspaceEffect(() => requireWorkspace(root));
		const issues = inspectWorkspace(workspace);
		const healthy = issues.length === 0;
		yield* Console.log(
			json
				? JSON.stringify({ healthy, root: workspace.root, issues }, null, 2)
				: healthy
					? "Workspace references are healthy."
					: issues.map((issue) => `${issue.code}\t${issue.project ?? "workspace"}\t${issue.message}`).join("\n"),
		);
		if (!healthy)
			yield* Effect.sync(() => {
				process.exitCode = 1;
			});
	}),
);

export const workspaceCommand = Command.make("workspace").pipe(
	Command.withSubcommands([init, add, list, doctor, workspaceMigrationCommand]),
	Command.withDescription("Initialize and inspect a portable multi-project workspace"),
);
