#!/usr/bin/env node
import { runWikiCommand } from "./wiki-command.ts";

runWikiCommand(process.argv.slice(2)).then(
	(result) => {
		process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
	},
	(error) => {
		process.stderr.write(
			`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Wiki command failed" })}\n`,
		);
		process.exitCode = 1;
	},
);
