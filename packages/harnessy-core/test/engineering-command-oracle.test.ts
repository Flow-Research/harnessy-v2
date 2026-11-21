import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REVIEWED_COMMAND_ORACLE_DIGEST, reviewedCommandOracle } from "../src/engineering/command-oracle-manifest.ts";
import { createHarnessyCommandWorkload } from "../src/engineering/command-workload.ts";
import { engineeringBenchmarkFixture } from "./fixtures/engineering-benchmark.ts";

const qualified = process.versions.node === "22.22.2" && process.versions.sqlite === "3.51.2";
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.skipIf(qualified)("refuses an unqualified actual Node/SQLite runtime before creating fixtures", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "oracle-runtime-")));
	roots.push(root);
	const output = join(root, "fixtures");
	await expect(createHarnessyCommandWorkload("local-status", output)).rejects.toThrow(
		/Unsupported command oracle runtime/,
	);
	expect(existsSync(output)).toBe(false);
});
describe.skipIf(!qualified)("reviewed command oracle admission", () => {
	it("exposes only immutable reviewed identities and binds both module forms to one digest", () => {
		expect(REVIEWED_COMMAND_ORACLE_DIGEST).toMatch(/^[a-f0-9]{64}$/);
		for (const profile of ["local-status", "preparation-plan"] as const)
			for (const form of ["ts", "js"] as const) {
				const oracle = reviewedCommandOracle(profile, form);
				expect(oracle.digest).toBe(REVIEWED_COMMAND_ORACLE_DIGEST);
				expect(Object.isFrozen(oracle)).toBe(true);
				expect(Object.isFrozen(oracle.files)).toBe(true);
				expect(oracle.files).not.toHaveLength(0);
				for (const file of oracle.files) {
					expect(Object.isFrozen(file)).toBe(true);
					expect(file.digest).toMatch(/^[a-f0-9]{64}$/);
				}
			}
	});
	it("rejects changed Store, contracts and factory sources before creating any seed, even with a caller override argument", async () => {
		const fixture = await engineeringBenchmarkFixture(true);
		roots.push(fixture.root);
		for (const name of ["store", "contracts", "command-workload"]) {
			const path = join(fixture.baseline, `packages/harnessy-core/src/engineering/${name}.ts`),
				original = await readFile(path, "utf8");
			await writeFile(path, `${original}\n// unreviewed semantic source\n`);
			const output = join(fixture.root, `refused-${name}`),
				entry = join(fixture.root, `child-${name}.mts`);
			await writeFile(
				entry,
				`import {createHarnessyCommandWorkload} from ${JSON.stringify(join(fixture.baseline, "packages/harnessy-core/src/engineering/command-workload.ts"))};\ntry { await createHarnessyCommandWorkload("local-status",${JSON.stringify(output)},undefined,{approved:true,files:{}}); process.stdout.write("unexpected-seed"); } catch(error) { process.stdout.write(String(error)); }\n`,
			);
			const result = await new Promise<string>((resolve, reject) =>
				execFile(
					process.execPath,
					["--experimental-strip-types", entry],
					{
						timeout: 10000,
						killSignal: "SIGKILL",
						maxBuffer: 16384,
						env: {
							PATH: "/usr/bin:/bin",
							LANG: "C",
							XDG_STATE_HOME: join(fixture.root, "unused-state"),
							HSY_AUTH_ENCRYPTION: "off",
							PI_AUTH_ENCRYPTION: "off",
						},
					},
					(error, stdout) => (error ? reject(error) : resolve(stdout)),
				),
			);
			expect(result).toMatch(/Unreviewed command oracle source/);
			expect(existsSync(output)).toBe(false);
			await writeFile(path, original);
		}
	}, 60000);
	it("rejects a missing semantic source before a fixture can be issued", async () => {
		const fixture = await engineeringBenchmarkFixture(true);
		roots.push(fixture.root);
		const output = join(fixture.root, "missing-seed");
		await rm(join(fixture.baseline, "packages/harnessy-core/src/engineering/host-contract.ts"));
		const entry = join(fixture.root, "missing.mts");
		await writeFile(
			entry,
			`import {createHarnessyCommandWorkload} from ${JSON.stringify(join(fixture.baseline, "packages/harnessy-core/src/engineering/command-workload.ts"))};\nawait createHarnessyCommandWorkload("local-status",${JSON.stringify(output)});\n`,
		);
		const error = await new Promise<Error | null>((resolve) =>
			execFile(
				process.execPath,
				["--experimental-strip-types", entry],
				{
					timeout: 10000,
					killSignal: "SIGKILL",
					maxBuffer: 16384,
					env: {
						PATH: "/usr/bin:/bin",
						LANG: "C",
						XDG_STATE_HOME: join(fixture.root, "unused-state"),
						HSY_AUTH_ENCRYPTION: "off",
						PI_AUTH_ENCRYPTION: "off",
					},
				},
				(cause) => resolve(cause),
			),
		);
		expect(error).not.toBeNull();
		expect(existsSync(output)).toBe(false);
	}, 60000);
});
