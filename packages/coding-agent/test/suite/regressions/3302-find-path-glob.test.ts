import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindToolDefinition, type FindToolOptions } from "../../../src/core/tools/find.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/fake-fd.mjs");

/**
 * Regression test for https://github.com/earendil-works/pi-mono/issues/3302
 *
 * The `find` tool advertises glob patterns like `src/**\/*.spec.ts`, but the
 * default fd-backed implementation used `fd --glob <pattern>` without
 * `--full-path`, which makes fd match only against the basename. Any pattern
 * containing a `/` therefore silently returned no matches.
 *
 * The fix switches fd into full-path mode when the pattern contains a `/`
 * and prepends `**\/` so the pattern can match against the absolute candidate
 * path that fd feeds to the matcher.
 */
describe("issue #3302 find returns no results for path-based glob patterns", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-3302-"));
		mkdirSync(join(tempRoot, "some", "parent", "child"), { recursive: true });
		mkdirSync(join(tempRoot, "src", "foo", "bar"), { recursive: true });
		writeFileSync(join(tempRoot, "some", "parent", "child", "file.ext"), "");
		writeFileSync(join(tempRoot, "some", "parent", "child", "test.spec.ts"), "");
		writeFileSync(join(tempRoot, "src", "foo", "bar", "example.spec.ts"), "");
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	const fixtureOptions: FindToolOptions = {
		resolveFd: () => ({ command: process.execPath, args: [fixturePath] }),
	};

	async function runFind(pattern: string, options: FindToolOptions = fixtureOptions): Promise<string[]> {
		const def = createFindToolDefinition(tempRoot, options);
		// The find tool implementation does not touch ctx; pass a minimal stub.
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute("call-1", { pattern }, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
		};
		const text = result.content[0]?.text ?? "";
		if (text === "No files found matching pattern") return [];
		return text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("["));
	}

	it("basename pattern still matches (regression-safe)", async () => {
		const files = await runFind("*.spec.ts");
		expect(files.sort()).toEqual(["some/parent/child/test.spec.ts", "src/foo/bar/example.spec.ts"]);
	});

	it("directory-prefixed pattern with ** tail matches subtree", async () => {
		const files = await runFind("some/parent/child/**");
		// Matches files (and possibly directories) under the subtree. Assert the two files are present.
		expect(files).toContain("some/parent/child/file.ext");
		expect(files).toContain("some/parent/child/test.spec.ts");
	});

	it("leading ** wildcard with path segments matches", async () => {
		const files = await runFind("**/parent/child/*");
		expect(files.sort()).toContain("some/parent/child/file.ext");
		expect(files.sort()).toContain("some/parent/child/test.spec.ts");
	});

	it("src/**/*.spec.ts matches nested spec file", async () => {
		const files = await runFind("src/**/*.spec.ts");
		expect(files).toEqual(["src/foo/bar/example.spec.ts"]);
	});

	it("rejects deterministically when fd is unavailable", async () => {
		await expect(runFind("*.spec.ts", { resolveFd: () => undefined })).rejects.toThrow(
			"fd is not available and could not be downloaded",
		);
	});

	it("rejects a nonzero fd exit that produced no results", async () => {
		await expect(runFind("__fail-empty__")).rejects.toThrow("fixture fd failure without output");
	});

	it("preserves fd output when fd returns partial results with a nonzero exit", async () => {
		await expect(runFind("__fail-with-output__")).resolves.toEqual(["some/parent/child/file.ext"]);
	});
});
