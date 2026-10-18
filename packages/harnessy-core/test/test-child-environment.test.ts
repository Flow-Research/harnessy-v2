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

/**
 * Spreads that keep the setting off: `fixtureEnvironment()` always, and `process.env` only in a
 * package whose vitest configuration sets PI_AUTH_ENCRYPTION to "off" for the test process.
 */
const safeSpread = (spread: string, trustProcessEnv: boolean) =>
	/^\.\.\.\s*fixtureEnvironment\(\)/u.test(spread) || (trustProcessEnv && /^\.\.\.\s*process\.env\b/u.test(spread));

/**
 * The effective value must be "off": an explicit `PI_AUTH_ENCRYPTION: "off"` that no later spread
 * can overwrite, or only safe spreads with no other value for it. Comments never count.
 */
const guarded = (literal: string, trustProcessEnv: boolean): boolean => {
	const body = literal.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
	const settings = [...body.matchAll(/\bPI_AUTH_ENCRYPTION\s*:\s*(["'`])([^"'`]*)\1/gu)];
	if (settings.some((setting) => setting[2] !== "off")) return false;
	if (/\bPI_AUTH_ENCRYPTION\s*:\s*[^"'`\s]/u.test(body)) return false;
	const spreads = [...body.matchAll(/\.\.\.\s*[^,}\n]+/gu)];
	const last = settings.at(-1);
	if (last !== undefined)
		return spreads.every((spread) => spread.index < last.index || safeSpread(spread[0], trustProcessEnv));
	return spreads.length > 0 && spreads.every((spread) => safeSpread(spread[0], trustProcessEnv));
};

const findUnguardedChildEnvironments = (source: string, trustProcessEnv = true): ReadonlyArray<number> => {
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
		if (guarded(source.slice(match.index, index), trustProcessEnv)) continue;
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

/** True when the package's vitest configuration sets PI_AUTH_ENCRYPTION to "off" for its tests. */
const vitestDisablesKeychain = (packageName: string) => {
	const config = join(packagesRoot, packageName, "vitest.config.ts");
	return (
		statSync(config, { throwIfNoEntry: false })?.isFile() === true &&
		/\benv\s*:\s*\{[^}]*\bPI_AUTH_ENCRYPTION\s*:\s*["']off["']/u.test(readFileSync(config, "utf8"))
	);
};

/**
 * Only files vitest runs inherit its PI_AUTH_ENCRYPTION setting through `process.env`.
 * Support scripts and package scripts run by plain node do not.
 */
const runByVitest = (path: string) => /\.test\.m?ts$/u.test(path) && !path.includes(join("test", "support"));

/** This guard's own fixture strings look like environments; it is not scanned. */
const SELF = resolve(import.meta.filename);

describe("test child-process environments", () => {
	it("never let a test child reach the OS keychain", () => {
		const offenders = ["harnessy-core", "harnessy-local-host", "harnessy-sdk", "harnessy-engine"].flatMap((name) => {
			const vitestOff = vitestDisablesKeychain(name);
			// Test code, test support run directly by node, and package scripts that start test children.
			return ["test", "scripts"]
				.map((folder) => join(packagesRoot, name, folder))
				.filter((directory) => statSync(directory, { throwIfNoEntry: false })?.isDirectory() === true)
				.flatMap(testFiles)
				.filter((path) => resolve(path) !== SELF)
				.flatMap((path) =>
					findUnguardedChildEnvironments(readFileSync(path, "utf8"), vitestOff && runByVitest(path)).map(
						(line) => `${relative(packagesRoot, path)}:${line}`,
					),
				);
		});
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
		// Only an effective "off" counts: not a comment, another value, or a value a later spread can replace.
		expect(findUnguardedChildEnvironments(spawning('env: { // PI_AUTH_ENCRYPTION: "off"\nHOME: "/tmp" },'))).toEqual([
			3,
		]);
		expect(findUnguardedChildEnvironments(spawning('env: { PI_AUTH_ENCRYPTION: "on" },'))).toEqual([3]);
		expect(findUnguardedChildEnvironments(spawning("env: { PI_AUTH_ENCRYPTION: mode },"))).toEqual([3]);
		expect(findUnguardedChildEnvironments(spawning('env: { PI_AUTH_ENCRYPTION: "off", ...extra },'))).toEqual([3]);
		expect(findUnguardedChildEnvironments(spawning('env: { ...extra, PI_AUTH_ENCRYPTION: "off" },'))).toEqual([]);
		expect(findUnguardedChildEnvironments(spawning('env: { ...process.env, PI_AUTH_ENCRYPTION: "on" },'))).toEqual([
			3,
		]);
		expect(findUnguardedChildEnvironments(spawning("env: { ...process.env, ...extra },"))).toEqual([3]);
		// process.env keeps it off only where the package's vitest configuration sets it off.
		expect(findUnguardedChildEnvironments(spawning('env: { ...process.env, HOME: "/tmp/x" },'), false)).toEqual([3]);
		expect(vitestDisablesKeychain("harnessy-core")).toBe(true);
		expect(vitestDisablesKeychain("harnessy-engine")).toBe(false);
		expect(runByVitest(join(packagesRoot, "harnessy-core/test/x.test.ts"))).toBe(true);
		expect(runByVitest(join(packagesRoot, "harnessy-local-host/test/support/smoke.mjs"))).toBe(false);
		expect(runByVitest(join(packagesRoot, "harnessy-sdk/scripts/bundle-notices.test.mjs"))).toBe(false);
		// The guard's own fixtures would be flagged if it scanned itself, so it excludes itself by path.
		expect(
			findUnguardedChildEnvironments(`${readFileSync(SELF, "utf8")}\nspawnSync("x", []);\n`).length,
		).toBeGreaterThan(0);
		// Names that merely contain "env" are not environments.
		expect(findUnguardedChildEnvironments(byName("const envelope = { a: 1 };"))).toEqual([]);
		// A file that starts no child process is out of scope.
		expect(findUnguardedChildEnvironments('readConfig({ env: { A: "1" } });')).toEqual([]);
	});
});
