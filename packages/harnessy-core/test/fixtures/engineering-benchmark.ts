import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function engineeringBenchmarkFixture(commands = false) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "engineering-benchmark-")));
	const checkout = fileURLToPath(new URL("../../../../", import.meta.url));
	const makeRepo = async (name: string, addition = "") => {
		const repo = join(root, name);
		await mkdir(join(repo, "packages/harnessy-core/src/work"), { recursive: true });
		await writeFile(join(repo, "packages/harnessy-core/package.json"), '{"name":"@harnessy/core","type":"module"}\n');
		await copyFile(
			join(checkout, "packages/harnessy-core/src/work/logic.ts"),
			join(repo, "packages/harnessy-core/src/work/logic.ts"),
		);
		if (commands) {
			await cp(join(checkout, "packages/harnessy-core/src"), join(repo, "packages/harnessy-core/src"), {
				recursive: true,
				force: true,
			});
			await symlink(
				await realpath(join(checkout, "packages/harnessy-core/node_modules")),
				join(repo, "packages/harnessy-core/node_modules"),
			);
		}
		if (addition) await writeFile(join(repo, "packages/harnessy-core/src/work/logic.ts"), addition, { flag: "a" });
		await writeFile(join(repo, ".gitignore"), "node_modules\n");
		await symlink(await realpath(join(checkout, "node_modules")), join(repo, "node_modules"));
		for (const args of [
			["init", "-q"],
			["config", "user.name", "Isolated fixture"],
			["config", "user.email", "fixture@example.invalid"],
			["add", "."],
			["-c", "core.hooksPath=/dev/null", "commit", "-qm", "Isolated workload fixture"],
		])
			execFileSync("/usr/bin/git", ["-C", repo, ...args], { stdio: "ignore" });
		return repo;
	};
	const baseline = await makeRepo("baseline");
	return { root, baseline, makeRepo, output: join(root, "result") };
}
