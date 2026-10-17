#!/usr/bin/env node
/**
 * `harnessy-portal`: the read-only local portal API. See `portal/command.ts`.
 * A known non-writer: it never spawns a meeting or community writer command.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { createLaunchdProbe } from "@harnessy/core/read-model";

import { PORTAL_USAGE, runPortalCommand } from "./portal/command.ts";
import { PortalStateError } from "./portal/token-store.ts";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	readonly version: string;
};
const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help")) {
	process.stdout.write(`${JSON.stringify({ usage: PORTAL_USAGE })}\n`);
} else {
	runPortalCommand(args, {
		env: process.env,
		homeDir: homedir(),
		write: (text) => process.stdout.write(text),
		version: packageJson.version,
		cliPath: fileURLToPath(import.meta.url),
		nodePath: process.execPath,
		probe: createLaunchdProbe(),
		openUrl: (url) => {
			const opener = process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
			spawn(opener, [url], { shell: false, stdio: "ignore", detached: true }).unref();
		},
	}).then(
		(result) => {
			if (result.kind !== "serving") return;
			const stop = () => {
				result.server.close().then(() => process.exit(0));
			};
			process.once("SIGTERM", stop);
			process.once("SIGINT", stop);
		},
		(error: unknown) => {
			const code = error instanceof PortalStateError ? error.code : "portal_failed";
			process.stderr.write(`${JSON.stringify({ error: code })}\n`);
			process.exitCode = 1;
		},
	);
}
