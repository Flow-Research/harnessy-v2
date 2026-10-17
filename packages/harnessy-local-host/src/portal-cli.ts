#!/usr/bin/env node
/**
 * `harnessy-portal`: the read-only local portal API. See `portal/command.ts`.
 * A known non-writer: it never spawns a meeting or community writer command.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { createLaunchdProbe } from "@harnessy/core/read-model";

import { PORTAL_USAGE, runPortalCommand } from "./portal/command.ts";
import { launchOpener, stopOnSignals, systemOpener } from "./portal/process.ts";
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
			launchOpener(systemOpener(process.platform), url, () => {
				process.stderr.write(
					`${JSON.stringify({ error: "portal_open_failed", hint: "harnessy portal open --print" })}\n`,
				);
				process.exitCode = 1;
			});
		},
	}).then(
		(result) => {
			if (result.kind !== "serving") return;
			stopOnSignals(result.server.close, {
				once: (signal, listener) => process.once(signal, listener),
				exit: (code) => process.exit(code),
			});
		},
		(error: unknown) => {
			const code = error instanceof PortalStateError ? error.code : "portal_failed";
			process.stderr.write(`${JSON.stringify({ error: code })}\n`);
			process.exitCode = 1;
		},
	);
}
