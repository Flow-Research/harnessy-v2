import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const QA_RUNTIME_SHA256 = "6ab7985d9c7c5e752d3cc25d4e56785d6c04630ba6b16ebfcf6d5714ae3aa585";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const qaRuntimePath = resolve(
	repositoryRoot,
	"packages/capability-harnessy-v1-full/resources/flow-install/skills/qa-runtime/scripts/qa-runtime-lib.mjs",
);

export const qaRuntimeSha256 = (content) => createHash("sha256").update(content).digest("hex");

export const assertQaRuntimeIdentity = (content = readFileSync(qaRuntimePath)) => {
	const actual = qaRuntimeSha256(content);
	if (actual !== QA_RUNTIME_SHA256) {
		throw new Error(
			`Preserved QA runtime digest changed: expected ${QA_RUNTIME_SHA256}, received ${actual}. Review and update the V2 bridge before using it.`,
		);
	}
	return actual;
};

export const runPinnedQaCli = async (argv, io = {}) => {
	assertQaRuntimeIdentity();
	const { runCli } = await import(pathToFileURL(qaRuntimePath).href);
	return runCli(argv, { commandName: "qa", cwd: repositoryRoot, ...io });
};
