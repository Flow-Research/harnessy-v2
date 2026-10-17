// Records what a portal child process spawns and opens, for the non-writer regression test.
//
//   node --import ./portal-recorder.mjs src/portal-cli.ts serve …
//
// Every wrapped function passes its arguments through unchanged; the recorder
// only appends one JSON line per call to PORTAL_RECORDER_LOG:
//   {"kind":"spawn","file":…,"args":[…]}   child_process.spawn/spawnSync/exec*/fork
//   {"kind":"open","path":…}               fs open/read entry points (sync, callback and promises)
//
// With PORTAL_RECORDER_STUB_LAUNCHCTL=1, a spawnSync of launchctl is recorded and answered with
// launchctl's own "service not found" result (exit 113) instead of running, so the test never reads
// the developer's live launchd state. Every other spawn still runs.
//
// With PORTAL_RECORDER_CORE_SOURCE set to packages/harnessy-core/src, `@harnessy/core/<subpath>`
// resolves to that source, so the child runs the code under test rather than a stale build.
import childProcess from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { register, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const logPath = process.env.PORTAL_RECORDER_LOG;
if (!logPath) throw new Error("PORTAL_RECORDER_LOG is required");
// Opened before any wrapping, and written with writeSync, so recording never records itself.
const logFd = fs.openSync(logPath, "a", 0o600);
const record = (entry) => fs.writeSync(logFd, `${JSON.stringify(entry)}\n`);
const stubLaunchctl = process.env.PORTAL_RECORDER_STUB_LAUNCHCTL === "1";
const STUB_NOT_FOUND = "Could not find service in domain for port\n";
const pathText = (value) =>
	typeof value === "string" ? value : value instanceof URL ? value.href : Buffer.isBuffer(value) ? value.toString() : null;

for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
	const original = childProcess[name];
	childProcess[name] = function recordedSpawn(file, args, ...rest) {
		record({ kind: "spawn", file: String(file), args: Array.isArray(args) ? args.map(String) : [] });
		if (name === "spawnSync" && stubLaunchctl && String(file).endsWith("/launchctl"))
			return { pid: 0, output: [null, "", STUB_NOT_FOUND], stdout: "", stderr: STUB_NOT_FOUND, status: 113, signal: null };
		return original.call(this, file, args, ...rest);
	};
}

const wrapOpen = (target, name) => {
	const original = target[name];
	target[name] = function recordedOpen(path, ...rest) {
		const text = pathText(path);
		if (text !== null) record({ kind: "open", path: text });
		return original.call(this, path, ...rest);
	};
};
for (const name of ["openSync", "open", "readFileSync", "readFile", "createReadStream", "opendirSync"]) wrapOpen(fs, name);
for (const name of ["open", "readFile", "opendir"]) wrapOpen(fsPromises, name);
syncBuiltinESMExports();

const coreSource = process.env.PORTAL_RECORDER_CORE_SOURCE;
if (coreSource) {
	const base = pathToFileURL(join(coreSource, "/")).href;
	register(
		`data:text/javascript,${encodeURIComponent(`
const base = ${JSON.stringify(base)};
export async function resolve(specifier, context, next) {
	const match = /^@harnessy\\/core\\/([a-z-]+)$/u.exec(specifier);
	return match === null ? next(specifier, context) : next(new URL(match[1] + ".ts", base).href, context);
}
`)}`,
	);
}
