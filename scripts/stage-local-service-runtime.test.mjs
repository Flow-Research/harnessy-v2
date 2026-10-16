import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { stageLocalServiceRuntime } from "./stage-local-service-runtime.mjs";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "harnessy-service-stage-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const modules = join(root, "installed", "node_modules");
	const target = join(root, "service");
	const pkg = (name, dependencies = {}, options = {}) => {
		const directory = join(options.modules ?? modules, name);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version: options.version ?? "1.0.0", dependencies, optionalDependencies: options.optionalDependencies }));
		writeFileSync(join(directory, "index.js"), `export default ${JSON.stringify(name)};\n`);
		return directory;
	};
	pkg("@harnessy/core", { effect: "1.0.0", marked: "1.0.0", "interactive-only": "1.0.0" });
	pkg("@harnessy/sdk", { "@harnessy/core": "1.0.0", effect: "1.0.0", "@libsql/client": "1.0.0" });
	pkg("@harnessy/local-host", { "@harnessy/core": "1.0.0", "@harnessy/sdk": "1.0.0", effect: "1.0.0" });
	pkg("effect");
	pkg("marked");
	pkg("@libsql/client", {}, { optionalDependencies: { "not-on-this-platform": "1.0.0" } });
	return { root, modules, target, pkg };
}

test("stages operational dependencies without changing package bytes or npm bin links", (t) => {
	const { modules, target } = fixture(t);
	mkdirSync(join(modules, ".bin"));
	symlinkSync("../@harnessy/core/index.js", join(modules, ".bin", "harnessy"));
	const result = stageLocalServiceRuntime(modules, target);
	assert.equal(result.packages.length, 6);
	for (const name of result.packages) {
		for (const file of ["package.json", "index.js"]) {
			assert.deepEqual(readFileSync(join(target, "node_modules", name, file)), readFileSync(join(modules, name, file)));
		}
	}
	assert.equal(existsSync(join(target, "node_modules", ".bin")), false);
	assert.equal(existsSync(join(modules, ".bin", "harnessy")), true);
});

test("preserves nested dependency versions and their resolution paths", (t) => {
	const { modules, target, pkg } = fixture(t);
	pkg("shared", {}, { version: "1.0.0" });
	pkg("@libsql/client", { shared: "2.0.0" });
	const nested = join(modules, "@libsql/client/node_modules");
	pkg("shared", {}, { modules: nested, version: "2.0.0" });
	const result = stageLocalServiceRuntime(modules, target);
	assert.ok(result.packages.includes("@libsql/client/node_modules/shared"));
	assert.equal(JSON.parse(readFileSync(join(target, "node_modules/@libsql/client/node_modules/shared/package.json"))).version, "2.0.0");
	assert.equal(existsSync(join(target, "node_modules/shared")), false);
});

test("missing required dependency fails and removes only newly staged output", (t) => {
	const { modules, target, pkg } = fixture(t);
	pkg("@libsql/client", { "missing-service-dependency": "1.0.0" });
	assert.throws(() => stageLocalServiceRuntime(modules, target), /Missing installed service dependency/);
	assert.equal(existsSync(target), false);
	assert.equal(existsSync(join(modules, "@harnessy/core/index.js")), true);
});

test("rejects a second Effect runtime even when npm installed both", (t) => {
	const { modules, target, pkg } = fixture(t);
	pkg("effect", {}, { modules: join(modules, "@harnessy/sdk/node_modules") });
	assert.throws(() => stageLocalServiceRuntime(modules, target), /one Effect runtime/);
	assert.equal(existsSync(target), false);
});

test("rejects a nested Core instead of shipping two authorization registries", (t) => {
	const { modules, target, pkg } = fixture(t);
	pkg("@harnessy/core", { effect: "1.0.0", marked: "1.0.0" }, {
		modules: join(modules, "@harnessy/sdk/node_modules"),
	});
	assert.throws(() => stageLocalServiceRuntime(modules, target), /one Core runtime/);
	assert.equal(existsSync(target), false);
});

test("existing destination and overlapping source are never replaced", (t) => {
	const { modules, target } = fixture(t);
	mkdirSync(target);
	writeFileSync(join(target, "keep"), "preserved");
	assert.throws(() => stageLocalServiceRuntime(modules, target), /already exists/);
	assert.equal(readFileSync(join(target, "keep"), "utf8"), "preserved");
	assert.throws(() => stageLocalServiceRuntime(modules, join(modules, "service")), /must be separate/);
	assert.throws(() => stageLocalServiceRuntime(modules, dirname(modules)), /must be separate/);
});

test("rejects package symlinks, unsafe modes and identity substitution", (t) => {
	const { modules, target, pkg } = fixture(t);
	const file = join(modules, "marked/index.js");
	symlinkSync("index.js", join(modules, "marked/alias.js"));
	assert.throws(() => stageLocalServiceRuntime(modules, target), /Unsafe installed/);
	rmSync(join(modules, "marked/alias.js"));
	if (process.platform !== "win32") {
		chmodSync(file, 0o666);
		assert.throws(() => stageLocalServiceRuntime(modules, target), /Unsafe installed/);
		chmodSync(file, 0o644);
	}
	pkg("marked");
	writeFileSync(join(modules, "marked/package.json"), JSON.stringify({ name: "substitute" }));
	assert.throws(() => stageLocalServiceRuntime(modules, target), /identity mismatch/);
	assert.equal(existsSync(target), false);
});
