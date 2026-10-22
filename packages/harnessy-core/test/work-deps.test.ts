import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkComponents,
	destinationProblem,
	leadsTo,
	linksOutside,
	makeParents,
	removeInside,
	sourceProblem,
	within,
} from "../src/work/deps.ts";

describe("dependency copy path checks", () => {
	let root = "";
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-deps-")));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("decides containment with path.relative, not a string prefix", () => {
		expect(within("/repo", "/repo")).toBe(true);
		expect(within("/repo", "/repo/node_modules")).toBe(true);
		expect(within("/repo", "/repo/..hidden")).toBe(true);
		expect(within("/repo", "/repo-evil/node_modules")).toBe(false);
		expect(within("/repo", "/repo/../x")).toBe(false);
		expect(within("/repo", "/")).toBe(false);
	});

	it("rejects paths that are not plain relative components", () => {
		for (const rel of ["", "a//b", "./a", "a/../b", "a/."])
			expect(checkComponents(root, rel)).toEqual({ problem: `${rel} is not a plain relative path` });
	});

	it("rejects a file where a directory is expected, and reports a missing source", () => {
		writeFileSync(join(root, "dist"), "");
		expect(sourceProblem(root, "dist")).toBe("source dist is a symbolic link or not a directory");
		expect(sourceProblem(root, "node_modules")).toBe("source node_modules does not exist");
		mkdirSync(join(root, "node_modules"));
		expect(sourceProblem(root, "node_modules")).toBeUndefined();
	});

	// macOS APFS is case- and normalisation-insensitive by default; on such a file
	// system lstat finds a variant name, and only the exact directory listing tells them apart.
	const probe = () => {
		const dir = mkdtempSync(join(tmpdir(), "harnessy-case-"));
		writeFileSync(join(dir, "a"), "");
		const insensitive = (() => {
			try {
				return realpathSync(join(dir, "A")) !== "";
			} catch {
				return false;
			}
		})();
		rmSync(dir, { recursive: true, force: true });
		return insensitive;
	};
	it.runIf(probe())("refuses a case or Unicode variant of a destination on an insensitive file system", () => {
		mkdirSync(join(root, "Node_Modules"));
		expect(destinationProblem(root, "node_modules")).toBe(
			"destination node_modules exists only under a different case or Unicode form",
		);
		mkdirSync(join(root, "café"));
		expect(destinationProblem(root, "café/dist")).toBe(
			"destination café exists only under a different case or Unicode form",
		);
	});

	it("creates missing parents one at a time, and reports one it cannot create", () => {
		expect(makeParents(root, "packages/a/dist")).toBeUndefined();
		expect(checkComponents(root, "packages/a")).toEqual({ existing: 2 });
		expect(makeParents(root, "packages/a/dist")).toBeUndefined();
		mkdirSync(join(root, "packages/a/dist"));
		expect(makeParents(root, "packages/a/dist")).toBe("destination packages/a/dist already exists in the worktree");
		mkdirSync(join(root, "locked"));
		chmodSync(join(root, "locked"), 0o555);
		expect(makeParents(root, "locked/b/dist")).toBe("destination locked/b could not be created");
		chmodSync(join(root, "locked"), 0o755);
	});

	it("removes only below plain parents and never follows a final link", () => {
		const outside = join(root, "outside");
		mkdirSync(join(outside, "dist"), { recursive: true });
		mkdirSync(join(root, "wt", "pkg"), { recursive: true });
		symlinkSync(join(outside, "dist"), join(root, "wt", "pkg", "dist"));
		expect(removeInside(join(root, "wt"), "pkg/dist")).toBe(true);
		expect(checkComponents(outside, "dist")).toEqual({ existing: 1 });
		symlinkSync(outside, join(root, "wt", "linked"));
		expect(removeInside(join(root, "wt"), "linked/dist")).toBe(false);
		expect(removeInside(join(root, "wt"), "missing/dist")).toBe(false);
		expect(checkComponents(outside, "dist")).toEqual({ existing: 1 });
	});

	it("follows every link, dangling ones and `..` after a link included, to where a write would land", () => {
		const outside = join(root, "outside");
		const wt = join(root, "wt");
		mkdirSync(join(outside, "sub"), { recursive: true });
		mkdirSync(join(wt, "node_modules"), { recursive: true });
		// A tracked link in the task branch whose target does not exist yet.
		symlinkSync(join(outside, "new"), join(wt, "evil"));
		symlinkSync("../evil", join(wt, "node_modules", "x"));
		expect(leadsTo(join(wt, "node_modules", "x", "file"))).toBe(join(outside, "new", "file"));
		// POSIX resolves the link before `..`.
		symlinkSync(join(outside, "sub"), join(wt, "deep"));
		expect(leadsTo(`${wt}/deep/../z`)).toBe(join(outside, "z"));
		expect(leadsTo(join(wt, ".", "node_modules"))).toBe(join(wt, "node_modules"));
		symlinkSync(join(wt, "loop-b"), join(wt, "loop-a"));
		symlinkSync(join(wt, "loop-a"), join(wt, "loop-b"));
		expect(leadsTo(join(wt, "loop-a"))).toBeUndefined();
	});

	it("lists copied links that lead outside the worktree, and keeps workspace links", () => {
		const wt = join(root, "wt");
		mkdirSync(join(wt, "node_modules", "@s"), { recursive: true });
		mkdirSync(join(wt, "packages", "a"), { recursive: true });
		symlinkSync("../../packages/a", join(wt, "node_modules", "@s", "a"));
		symlinkSync("./not-built", join(wt, "node_modules", "pending"));
		symlinkSync(join(root, "repo-evil"), join(wt, "node_modules", "prefix"));
		symlinkSync(join(wt, "node_modules", "loop"), join(wt, "node_modules", "loop"));
		expect(linksOutside(join(wt, "node_modules"), wt)).toEqual([
			join(wt, "node_modules", "loop"),
			join(wt, "node_modules", "prefix"),
		]);
	});
});
