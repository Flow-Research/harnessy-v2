import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const temporaryRoot = realpathSync(tmpdir());
const roots: string[] = [];
const children: ChildProcess[] = [];

/** Fail any test that resolves a path outside the temporary directory. */
export const assertInsideTemp = (...paths: ReadonlyArray<string>): void => {
	for (const path of paths) {
		const fromTemp = relative(temporaryRoot, resolve(path));
		if (fromTemp === "" || fromTemp.startsWith("..") || resolve(path) === fromTemp)
			throw new Error(`test path left the temporary directory: ${path}`);
	}
};

/** A fresh, real (symlink-free) home directory under the temporary directory. */
export const tempHome = (prefix: string): string => {
	const root = realpathSync(mkdtempSync(join(temporaryRoot, `harnessy-read-model-${prefix}-`)));
	roots.push(root);
	assertInsideTemp(root);
	return root;
};

/** Every file and directory under `root` with its size and modification time. */
export const treeListing = (root: string): ReadonlyArray<string> => {
	assertInsideTemp(root);
	const listing: string[] = [];
	const visit = (directory: string) => {
		for (const name of readdirSync(directory).sort()) {
			const path = join(directory, name);
			const stat = lstatSync(path);
			listing.push(`${relative(root, path)} ${stat.isDirectory() ? "dir" : stat.size} ${stat.mtimeMs} ${stat.ino}`);
			if (stat.isDirectory() && !stat.isSymbolicLink()) visit(path);
		}
	};
	visit(root);
	return listing;
};

/** SHA-256, size, modification time and inode of one database, plus which sidecars exist. */
export const databaseFingerprint = (path: string) => {
	assertInsideTemp(path);
	const stat = lstatSync(path);
	return {
		sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		ino: stat.ino,
		sidecars: ["-journal", "-wal", "-shm"].filter((suffix) =>
			lstatSync(`${path}${suffix}`, { throwIfNoEntry: false }),
		),
	};
};

const lockChild = fileURLToPath(new URL("./sqlite-lock-child.mjs", import.meta.url));

/** Start a real SQLite writer process and wait until it holds its lock or dirty transaction. */
export const startSqliteWriter = (database: string, mode: "exclusive" | "hot-journal"): Promise<ChildProcess> => {
	assertInsideTemp(database);
	const child = spawn(process.execPath, ["--no-warnings", lockChild, database, mode], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	return new Promise((resolveReady, rejectReady) => {
		let output = "";
		const timer = setTimeout(() => rejectReady(new Error(`writer did not start: ${output}`)), 15_000);
		child.stdout?.on("data", (chunk) => {
			output += String(chunk);
			if (output.includes("ready")) {
				clearTimeout(timer);
				resolveReady(child);
			}
		});
		child.stderr?.on("data", (chunk) => {
			output += String(chunk);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			rejectReady(new Error(`writer exited early (${code}): ${output}`));
		});
	});
};

/** Kill a writer and wait until the process is gone. */
export const killWriter = (child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): Promise<void> =>
	new Promise((resolveExit) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
		child.once("exit", () => resolveExit());
		child.kill(signal);
	});

export const cleanupReadModelFixtures = async (): Promise<void> => {
	await Promise.all(children.splice(0).map((child) => killWriter(child)));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
};
