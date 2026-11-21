import { execFile } from "node:child_process";
import {
	copyFile,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { freezeCommandDependencies } from "../src/engineering/command-dependencies.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("freezes actual installed importer-relative packages and refuses mapping, inventory and byte tampering", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "command-dependencies-")));
	roots.push(root);
	const source = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
	const closure = await freezeCommandDependencies([source], join(root, "frozen"));
	expect(await closure.observe()).toBe(closure.digest);
	const platform = closure.mappings["@effect/platform-node"];
	const nested = join(platform, "node_modules/undici");
	const original = await readlink(nested);
	expect(JSON.parse(await readFile(join(original, "package.json"), "utf8")).version).toBe("8.12.4");
	await rm(nested);
	await symlink(closure.mappings.zod, nested);
	await expect(closure.observe()).rejects.toThrow(/mapping changed/);
	await rm(nested);
	await symlink(original, nested);
	const native = join(closure.mappings.zod, "unreviewed.node");
	await writeFile(native, "unqualified native module");
	await expect(closure.observe()).rejects.toThrow(/Native/);
	await rm(native);
	const manifest = join(closure.mappings.zod, "package.json"),
		bytes = await readFile(manifest);
	await writeFile(manifest, Buffer.concat([bytes, Buffer.from("\n")]));
	await expect(closure.observe()).rejects.toThrow(/bytes or modes/);
	await writeFile(manifest, bytes);
	await mkdir(join(closure.mappings.zod, "node_modules"));
	await symlink(original, join(closure.mappings.zod, "node_modules/unreviewed"));
	await expect(closure.observe()).rejects.toThrow(/Unexpected nested/);
}, 60000);
it("rejects source dependency substitution and cancels copying without issuing partial custody", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "command-dependency-cancel-")));
	roots.push(root);
	await mkdir(join(root, "source/packages/harnessy-core"), { recursive: true });
	await expect(freezeCommandDependencies([join(root, "source")], join(root, "substitution"))).rejects.toThrow(
		/Required command dependency|topology|bytes/,
	);
	const source = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 25);
	await expect(freezeCommandDependencies([source], join(root, "cancelled"), controller.signal)).rejects.toThrow(
		/cancelled/,
	);
	clearTimeout(timer);
	expect(await readdir(root)).not.toContain("cancelled");
}, 60000);

async function lockFixture(layout: "workspace" | "package") {
	const root = await realpath(await mkdtemp(join(tmpdir(), "command-lock-")));
	roots.push(root);
	const source = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
	const controller = layout === "workspace" ? join(root, "packages/harnessy-core") : join(root, "installed/core");
	await mkdir(join(controller, "src/engineering"), { recursive: true, mode: 0o700 });
	await copyFile(join(source, "packages/harnessy-core/package.json"), join(controller, "package.json"));
	await copyFile(
		join(source, "packages/harnessy-core/src/engineering/command-dependencies.ts"),
		join(controller, "src/engineering/command-dependencies.ts"),
	);
	if (layout === "workspace") await copyFile(join(source, "package.json"), join(root, "package.json"));
	for (const name of ["effect", "@effect/platform-node", "zod"]) {
		const packagePath = createRequire(import.meta.url).resolve(`${name}/package.json`);
		const target = await realpath(join(packagePath, ".."));
		const destination = join(controller, "node_modules", name);
		await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
		await symlink(target, destination);
	}
	return { root, source, controller };
}
async function lockChild(fixture: Awaited<ReturnType<typeof lockFixture>>, body: string) {
	const entry = join(fixture.root, "lock-child.mts");
	await writeFile(
		entry,
		`import {freezeCommandDependencies} from ${JSON.stringify(join(fixture.controller, "src/engineering/command-dependencies.ts"))};\nimport {copyFile,writeFile} from "node:fs/promises";\nconst closure=await freezeCommandDependencies([${JSON.stringify(fixture.source)}],${JSON.stringify(join(fixture.root, "frozen"))},AbortSignal.timeout(50000));\n${body}\n`,
	);
	return new Promise<string>((resolve, reject) =>
		execFile(
			process.execPath,
			["--experimental-strip-types", entry],
			{
				timeout: 55000,
				killSignal: "SIGKILL",
				maxBuffer: 16384,
				env: { PATH: "/usr/bin:/bin", LANG: "C", HSY_AUTH_ENCRYPTION: "off", PI_AUTH_ENCRYPTION: "off" },
			},
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		),
	);
}
it("pins an owned absent lock and refuses its later injection or changed bytes", async () => {
	const fixture = await lockFixture("workspace");
	const result = await lockChild(
		fixture,
		`if(closure.runtimeLock.status!=="unavailable"||closure.runtimeLock.layout!=="owned-workspace")throw Error("Wrong absent lock classification");await copyFile(${JSON.stringify(join(fixture.source, "package-lock.json"))},${JSON.stringify(join(fixture.root, "package-lock.json"))});try{await closure.observe();throw Error("Injected lock accepted");}catch(error){process.stdout.write(String(error));}`,
	);
	expect(result).toMatch(/runtime lock status or identity changed/);
}, 60000);
it("does not attribute unrelated parent locks to a non-workspace package", async () => {
	const fixture = await lockFixture("package");
	await copyFile(join(fixture.source, "package-lock.json"), join(fixture.root, "package-lock.json"));
	const result = await lockChild(
		fixture,
		`if(closure.runtimeLock.status!=="unavailable"||closure.runtimeLock.layout!=="installed-package")throw Error("Unrelated lock was attributed");await writeFile(${JSON.stringify(join(fixture.root, "package-lock.json"))},"unrelated changed lock");await closure.observe();process.stdout.write(JSON.stringify(closure.runtimeLock));`,
	);
	expect(JSON.parse(result)).toMatchObject({ status: "unavailable", layout: "installed-package" });
	expect(JSON.parse(result)).not.toHaveProperty("digest");
}, 60000);
it("refuses changed bytes in a previously observed owned runtime lock", async () => {
	const fixture = await lockFixture("workspace");
	await copyFile(join(fixture.source, "package-lock.json"), join(fixture.root, "package-lock.json"));
	const result = await lockChild(
		fixture,
		`if(closure.runtimeLock.status!=="observed")throw Error("Owned lock was not observed");await writeFile(${JSON.stringify(join(fixture.root, "package-lock.json"))},${JSON.stringify(`${await readFile(join(fixture.root, "package-lock.json"), "utf8")}\n`)});try{await closure.observe();throw Error("Changed lock accepted");}catch(error){process.stdout.write(String(error));}`,
	);
	expect(result).toMatch(/runtime lock status or identity changed/);
}, 60000);

it("accepts separate identical dependency copies and rejects same-version source byte drift", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "portable-command-deps-")));
	roots.push(root);
	const source = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
	await mkdir(join(root, "node_modules"), { mode: 0o700 });
	const installedCopy = await freezeCommandDependencies([source], join(root, "node_modules/installed-copy"));
	const clone = join(root, "source");
	await mkdir(join(clone, "packages/harnessy-core/node_modules"), { recursive: true, mode: 0o700 });
	await copyFile(
		join(source, "packages/harnessy-core/package.json"),
		join(clone, "packages/harnessy-core/package.json"),
	);
	for (const [name, target] of Object.entries(installedCopy.mappings)) {
		const destination = join(clone, "packages/harnessy-core/node_modules", name);
		await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
		await symlink(target, destination);
	}
	const closure = await freezeCommandDependencies([clone], join(root, "verified"));
	expect(await closure.observe()).toBe(closure.digest);
	const effectPeer = join(installedCopy.mappings["@effect/platform-node"], "node_modules/effect");
	const previousPeer = await readlink(effectPeer),
		duplicate = join(root, "node_modules/duplicate-effect");
	await cp(installedCopy.mappings.effect, duplicate, { recursive: true, dereference: false });
	await rm(effectPeer);
	await symlink(duplicate, effectPeer);
	await expect(freezeCommandDependencies([clone], join(root, "different-instance"))).rejects.toThrow(
		/instance topology/,
	);
	await rm(effectPeer);
	await symlink(previousPeer, effectPeer);
	await rm(duplicate, { recursive: true, force: true });
	const manifest = join(installedCopy.mappings.effect, "package.json");
	await writeFile(manifest, `${await readFile(manifest, "utf8")}\n`);
	await expect(closure.observe()).rejects.toThrow(/dependency bytes, modes or instance topology/);
}, 60000);
