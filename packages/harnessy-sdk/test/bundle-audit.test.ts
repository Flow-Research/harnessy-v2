import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const auditor = fileURLToPath(new URL("../scripts/audit-bundles.mjs", import.meta.url));
const guard = fileURLToPath(
	new URL("../../harnessy-local-host/test/support/fixture-network-guard.mjs", import.meta.url),
);

function audit(nodeSource: string, portableFile?: "index.js" | "compose-fixture.d.ts") {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-bundle-audit-")));
	try {
		for (const directory of ["dist", "scripts", "node_modules"]) mkdirSync(join(root, directory));
		copyFileSync(auditor, join(root, "scripts", "audit-bundles.mjs"));
		// Only the parser dependency is linked; the auditor itself is copied
		// byte-for-byte and all package/bundle inputs are synthetic local files.
		symlinkSync(
			dirname(require.resolve("typescript/package.json")),
			join(root, "node_modules", "typescript"),
			"junction",
		);
		writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", dependencies: {} }));
		const files: Record<string, string> = {
			"index.js": "export {};\n",
			"index.d.ts": 'export type { Fixture } from "./compose-fixture.js";\n',
			"compose-fixture.d.ts": "export type Fixture = string;\n",
			"node.js": nodeSource,
			"node.d.ts": "export {};\n",
		};
		if (portableFile) files[portableFile] += 'import { DatabaseSync } from "node:sqlite";\n';
		for (const [name, source] of Object.entries(files)) writeFileSync(join(root, "dist", name), source);
		const result = spawnSync(process.execPath, ["--import", guard, join(root, "scripts", "audit-bundles.mjs")], {
			cwd: root,
			env: { NODE_NO_WARNINGS: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
			encoding: "utf8",
			timeout: 10000,
		});
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		for (const [name, source] of Object.entries(files))
			expect(readFileSync(join(root, "dist", name), "utf8")).toBe(source);
		expect(readFileSync(join(root, "scripts", "audit-bundles.mjs"))).toEqual(readFileSync(auditor));
		return result;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("real SDK bundle auditor prefix-only SQLite imports", () => {
	it("accepts node:sqlite in the Node entry and preserves the portable root", () => {
		const result = audit('import { DatabaseSync } from "node:sqlite";\n');
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ stableRoot: "portable", auditMode: "read-only" });
	});
	it.each([
		'import { DatabaseSync } from "sqlite";',
		"import { DatabaseSync } from 'sqlite';",
		'const sqlite = require("sqlite");',
		'const sqlite = __require("sqlite");',
		'const sqlite = import("sqlite");',
	])("rejects undeclared bare package import: %s", (source) => {
		const result = audit(source);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Harnessy SDK node.js retains undeclared runtime import sqlite");
	});
	it.each(["index.js", "compose-fixture.d.ts"] as const)("rejects node:sqlite in portable closure %s", (file) => {
		const result = audit("export {};", file);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(`Harnessy SDK stable root reaches Node-only imports in ${file}: node:sqlite`);
	});
});
