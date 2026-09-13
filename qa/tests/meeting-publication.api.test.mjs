// @qa-spec: qa/api/scripts/meeting-publication.md
// @qa-suite: MEET (meeting-publication)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const run = (workspace, files, timeout = 180_000) => {
	const result = spawnSync("npm", ["--workspace", workspace, "exec", "--", "vitest", "--run", ...files], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, PI_OFFLINE: "1" },
        timeout,
    });
    assert.equal(result.status, 0, `${workspace} meeting suites failed (${result.error?.message ?? result.signal ?? "test failure"})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
};

test("MEET-001 V2 full review preserves meeting edit, decision, and dispatch behavior", () => {
    run("@harnessy/core", [
        "test/meeting-publication-operational-full-review.test.ts",
        "test/meeting-publication-review-dispatch.test.ts",
    ], 300_000); // Signed-artifact validation across 41 runtime scenarios exceeded 180s on hosted CI.
    run("@harnessy/local-host", ["test/meeting-review-command.test.ts"]);
});
