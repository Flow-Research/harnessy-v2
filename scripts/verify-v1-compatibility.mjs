#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyV1Compatibility } from "./v1-compatibility-lib.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(
	process.argv[2] ?? joinDefault(repositoryRoot, "packages/capability-harnessy-v1-full"),
);

function joinDefault(root, path) {
	return resolve(root, path);
}

try {
	const result = await verifyV1Compatibility(packageRoot);
	process.stdout.write(
		`${JSON.stringify(
			{
				ok: result.ok,
				issues: result.issues,
				tree: {
					algorithm: result.source.algorithm,
					digest: result.source.digest,
					fileCount: result.source.fileCount,
					byteCount: result.source.byteCount,
				},
			},
			null,
			2,
		)}\n`,
	);
	if (!result.ok) process.exitCode = 1;
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
