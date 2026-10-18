import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No test may let a child process reach the macOS keychain. The auth store
 * uses the platform keychain unless PI_AUTH_ENCRYPTION is "off", and a child
 * that runs with a temporary HOME makes macOS ask the owner to reset the
 * keychain. The vitest configurations set PI_AUTH_ENCRYPTION=off for the test
 * process, but a child given an explicit environment does not inherit it.
 *
 * Rule: in a test file that starts child processes, every `env: { … }` object,
 * and every object literal bound to an env-named variable (`const env = { … }`),
 * must set PI_AUTH_ENCRYPTION, spread `process.env`, or spread
 * `fixtureEnvironment()`. An `env` object that is not a child-process
 * environment carries the marker comment on the line above it.
 */
const NOT_A_CHILD_ENV_MARKER = "harnessy-test-env: configuration, not a child process environment";

const CHILD_PROCESS_CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|fork|exec|execSync)\s*\(/u;
/** `env: { … }`, and an object literal bound to an env-named variable (`const env = { … }`), then passed by name. */
const ENV_OBJECT = /\benv\s*:\s*\{|\b(?:const|let|var)\s+(?:env|\w+Env)\s*(?::[^=;]+)?=\s*\{/gu;

const findUnguardedChildEnvironments = (source: string): ReadonlyArray<number> => {
	if (!CHILD_PROCESS_CALL.test(source)) return [];
	const lines: number[] = [];
	for (const match of source.matchAll(ENV_OBJECT)) {
		let index = match.index + match[0].length;
		let depth = 1;
		while (depth > 0 && index < source.length) {
			if (source[index] === "{") depth++;
			else if (source[index] === "}") depth--;
			index++;
		}
		const body = source.slice(match.index, index);
		if (/PI_AUTH_ENCRYPTION|\.\.\.\s*process\.env\b|\.\.\.\s*fixtureEnvironment\(/u.test(body)) continue;
		const before = source.slice(0, match.index).split("\n");
		if (before.at(-2)?.includes(NOT_A_CHILD_ENV_MARKER) === true) continue;
		lines.push(before.length);
	}
	return lines;
};

const packagesRoot = resolve(import.meta.dirname, "../..");
const testFiles = (directory: string): string[] =>
	readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) return name === "node_modules" ? [] : testFiles(path);
		return /\.(?:ts|mts|js|mjs)$/u.test(name) ? [path] : [];
	});

describe("test child-process environments", () => {
	it("never let a test child reach the OS keychain", () => {
		const offenders = ["harnessy-core", "harnessy-local-host", "harnessy-sdk", "harnessy-engine"]
			.map((name) => join(packagesRoot, name, "test"))
			.filter((directory) => statSync(directory, { throwIfNoEntry: false })?.isDirectory() === true)
			.flatMap(testFiles)
			.flatMap((path) =>
				findUnguardedChildEnvironments(readFileSync(path, "utf8")).map(
					(line) => `${relative(packagesRoot, path)}:${line}`,
				),
			);
		expect(offenders, 'add PI_AUTH_ENCRYPTION: "off" to these child environments').toEqual([]);
	});

	it("recognizes guarded, inherited and marked environments", () => {
		const spawning = (body: string) =>
			`import { spawnSync } from "node:child_process";\nspawnSync("x", [], {\n${body}\n});\n`;
		expect(findUnguardedChildEnvironments(spawning('env: { HOME: "/tmp/x" },'))).toEqual([3]);
		expect(findUnguardedChildEnvironments(spawning("env: {},"))).toEqual([3]);
		expect(findUnguardedChildEnvironments(spawning('env: { HOME: "/tmp/x", PI_AUTH_ENCRYPTION: "off" },'))).toEqual(
			[],
		);
		expect(findUnguardedChildEnvironments(spawning('env: { ...process.env, HOME: "/tmp/x" },'))).toEqual([]);
		expect(findUnguardedChildEnvironments(spawning("env: { ...fixtureEnvironment(), X: '1' },"))).toEqual([]);
		expect(findUnguardedChildEnvironments(spawning(`// ${NOT_A_CHILD_ENV_MARKER}\nenv: { A: "1" },`))).toEqual([]);
		// Nested objects inside the environment are part of it.
		expect(findUnguardedChildEnvironments(spawning('env: { A: "1", nested: { B: "2" } },'))).toEqual([3]);
		// An environment built in a variable and passed by shorthand is inspected too.
		const byName = (declaration: string) =>
			`import { spawnSync } from "node:child_process";\n${declaration}\nspawnSync("x", [], { env });\n`;
		expect(findUnguardedChildEnvironments(byName('const env = { PATH: "/usr/bin" };'))).toEqual([2]);
		expect(findUnguardedChildEnvironments(byName('const childEnv: NodeJS.ProcessEnv = { HOME: "/tmp" };'))).toEqual([
			2,
		]);
		expect(
			findUnguardedChildEnvironments(byName('const env = { PI_AUTH_ENCRYPTION: "off", PATH: "/usr/bin" };')),
		).toEqual([]);
		// Names that merely contain "env" are not environments.
		expect(findUnguardedChildEnvironments(byName("const envelope = { a: 1 };"))).toEqual([]);
		// A file that starts no child process is out of scope.
		expect(findUnguardedChildEnvironments('readConfig({ env: { A: "1" } });')).toEqual([]);
	});
});
