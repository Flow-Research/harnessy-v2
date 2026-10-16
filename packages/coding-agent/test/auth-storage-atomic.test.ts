import { spawnSync } from "node:child_process";
import {
	closeSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";

const roots: string[] = [];
const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "auth-atomic-"));
	roots.push(root);
	const path = join(root, "auth.json");
	writeFileSync(path, '{"old":"synthetic"}', { mode: 0o600 });
	return { root, path };
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([false, true])("replaces credentials atomically (async=%s)", async (asynchronous) => {
	const { root, path } = fixture();
	const previous = openSync(path, "r");
	try {
		const backend = new FileAuthStorageBackend(path);
		if (asynchronous) await backend.withLockAsync(async () => ({ result: undefined, next: '{"new":"synthetic"}' }));
		else backend.withLock(() => ({ result: undefined, next: '{"new":"synthetic"}' }));
		expect(readFileSync(previous, "utf8")).toBe('{"old":"synthetic"}');
		expect(readFileSync(path, "utf8")).toBe('{"new":"synthetic"}');
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(root)).toEqual(["auth.json"]);
	} finally {
		closeSync(previous);
	}
});

it.skipIf(process.platform === "win32")("preserves an existing credential symlink", async () => {
	const { root, path } = fixture();
	const link = join(root, "linked.json");
	symlinkSync(path, link);
	await new FileAuthStorageBackend(link).withLockAsync(async () => ({
		result: undefined,
		next: '{"new":"synthetic"}',
	}));
	expect(lstatSync(link).isSymbolicLink()).toBe(true);
	expect(readFileSync(path, "utf8")).toBe('{"new":"synthetic"}');
});

it.skipIf(process.platform === "win32")(
	"keeps the previous credential intact when killed during replacement write",
	() => {
		const { root, path } = fixture();
		const entry = join(root, "crash.mjs");
		const storage = fileURLToPath(new URL("../src/core/auth-storage.ts", import.meta.url));
		writeFileSync(
			entry,
			`import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { FileAuthStorageBackend } from ${JSON.stringify(storage)};
const write = fs.writeFileSync;
fs.writeFileSync = (path, data, options) => {
 if (String(data).includes('new')) { write(path, '{"new":', options); process.kill(process.pid, 'SIGKILL'); }
 return write(path, data, options);
};
syncBuiltinESMExports();
await new FileAuthStorageBackend(${JSON.stringify(path)}).withLockAsync(async () => ({ result: undefined, next: '{"new":"synthetic"}' }));
`,
		);
		const child = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
			encoding: "utf8",
			timeout: 10000,
			env: { PATH: process.env.PATH },
		});
		expect(child.signal, child.stderr).toBe("SIGKILL");
		expect(readFileSync(path, "utf8")).toBe('{"old":"synthetic"}');
	},
);
