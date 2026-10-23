import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	auditCopy,
	destinationProblem,
	makeParents,
	removeCopy,
	removeTree,
	sourceProblem,
	stripSensitive,
	within,
} from "../src/work/deps.ts";

describe("dependency copy checks", () => {
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

	it("accepts only a plain source directory reached through no link", () => {
		expect(sourceProblem(root, "a//b")).toBe("source a//b is not a plain relative path");
		expect(sourceProblem(root, "../x")).toBe("source ../x is not a plain relative path");
		expect(sourceProblem(root, "node_modules")).toBe("source node_modules does not exist");
		writeFileSync(join(root, "dist"), "");
		expect(sourceProblem(root, "dist")).toBe("source dist is a symbolic link or not a directory");
		mkdirSync(join(root, "node_modules"));
		expect(sourceProblem(root, "node_modules")).toBeUndefined();
		mkdirSync(join(root, "node_modules", "dist"));
		symlinkSync(join(root, "node_modules"), join(root, "pkg"));
		expect(sourceProblem(root, "pkg/dist")).toBe(
			`source pkg/dist resolves to ${join(root, "node_modules", "dist")}: a link, a case or Unicode variant, or a path outside`,
		);
	});

	it("accepts only a destination that does not exist in any form", () => {
		expect(destinationProblem(root, "packages/a/dist")).toBeUndefined();
		expect(destinationProblem(root, "../dist")).toBe("destination ../dist is not a plain relative path");
		symlinkSync(join(root, "missing-target"), join(root, "node_modules"));
		expect(destinationProblem(root, "node_modules")).toBe("destination node_modules already exists in the worktree");
		writeFileSync(join(root, "file"), "");
		expect(destinationProblem(root, "file/dist")).toBe("destination file is a symbolic link or not a directory");
		mkdirSync(join(root, "dist"));
		expect(destinationProblem(root, "dist")).toBe("destination dist already exists in the worktree");
	});

	// macOS APFS is case- and normalisation-insensitive by default; lstat finds a
	// variant name there, and only the exact directory listing tells them apart.
	const insensitive = (() => {
		const dir = mkdtempSync(join(tmpdir(), "harnessy-case-"));
		writeFileSync(join(dir, "a"), "");
		const found = existsSync(join(dir, "A"));
		rmSync(dir, { recursive: true, force: true });
		return found;
	})();
	it.runIf(insensitive)("refuses a case or Unicode variant of a destination", () => {
		mkdirSync(join(root, "Node_Modules"));
		expect(destinationProblem(root, "node_modules")).toBe("destination node_modules already exists in the worktree");
		mkdirSync(join(root, "Packages"));
		expect(destinationProblem(root, "packages/dist")).toBe(
			`destination packages resolves to ${join(root, "Packages")}: a link, a case or Unicode variant, or a path outside`,
		);
		expect(sourceProblem(root, "packages")).toContain("source packages resolves to ");
		mkdirSync(join(root, "cafe\u0301"));
		expect(destinationProblem(root, "caf\u00e9/dist")).toContain("resolves to ");
	});

	it("creates missing parents one at a time, and reports one it cannot create", () => {
		mkdirSync(join(root, "packages"));
		expect(makeParents(root, "packages/a/dist")).toBeUndefined();
		expect(existsSync(join(root, "packages/a"))).toBe(true);
		mkdirSync(join(root, "packages/a/dist"));
		expect(makeParents(root, "packages/a/dist")).toBe("destination packages/a/dist already exists in the worktree");
		mkdirSync(join(root, "locked"));
		chmodSync(join(root, "locked"), 0o555);
		expect(makeParents(root, "locked/b/dist")).toBe("destination locked/b could not be created");
		chmodSync(join(root, "locked"), 0o755);
	});

	it("removes read-only trees, never through a link, and reports what it cannot remove", () => {
		const outside = join(root, "outside");
		mkdirSync(join(outside, "dist"), { recursive: true });
		mkdirSync(join(root, "wt", "pkg", "sub"), { recursive: true });
		writeFileSync(join(root, "wt", "pkg", "sub", "f"), "");
		chmodSync(join(root, "wt", "pkg", "sub"), 0o555);
		expect(removeTree(join(root, "wt", "pkg"))).toBe(true);
		symlinkSync(outside, join(root, "wt", "linked"));
		expect(removeCopy(join(root, "wt"), "linked/dist")).toBe(false);
		expect(existsSync(join(outside, "dist"))).toBe(true);
		// A final link is removed itself; its target stays.
		mkdirSync(join(root, "wt", "pkg"));
		symlinkSync(join(outside, "dist"), join(root, "wt", "pkg", "dist"));
		expect(removeCopy(join(root, "wt"), "pkg/dist")).toBe(true);
		expect(existsSync(join(outside, "dist"))).toBe(true);
		expect(removeCopy(join(root, "wt"), "missing/dist")).toBe(true);
		mkdirSync(join(root, "wt", "node_modules"));
		expect(removeCopy(join(root, "wt"), "node_modules")).toBe(true);
		mkdirSync(join(root, "ro", "pkg"), { recursive: true });
		chmodSync(join(root, "ro"), 0o555);
		expect(removeTree(join(root, "ro", "pkg"))).toBe(false);
		chmodSync(join(root, "ro"), 0o755);
	});

	it("withholds files that may hold secrets, and node_modules caches", () => {
		const copy = join(root, "node_modules");
		for (const file of [
			".env",
			".env.local",
			".npmrc",
			".yarnrc.yml",
			"pkg/server.pem",
			"pkg/id.KEY",
			"pkg/index.js",
		]) {
			mkdirSync(join(copy, file, ".."), { recursive: true });
			writeFileSync(join(copy, file), "");
		}
		mkdirSync(join(copy, ".cache", "babel"), { recursive: true });
		mkdirSync(join(copy, "pkg", "node_modules", ".cache"), { recursive: true });
		mkdirSync(join(copy, "pkg", ".cache"), { recursive: true });
		expect(stripSensitive(copy, true)).toEqual([
			".cache",
			".env",
			".env.local",
			".npmrc",
			".yarnrc.yml",
			"pkg/id.KEY",
			"pkg/node_modules/.cache",
			"pkg/server.pem",
		]);
		// Only node_modules/.cache is a cache; a package's own .cache directory stays.
		expect(existsSync(join(copy, "pkg", ".cache"))).toBe(true);
		expect(existsSync(join(copy, "pkg", "index.js"))).toBe(true);
		mkdirSync(join(root, "dist", ".cache"), { recursive: true });
		expect(stripSensitive(join(root, "dist"), false)).toEqual([]);
	});

	it("audits a copy: files, directories and links inside the worktree or the source only", () => {
		const wt = join(root, "wt");
		const repo = join(root, "repo");
		mkdirSync(join(repo, "node_modules"), { recursive: true });
		mkdirSync(join(wt, "node_modules", "@s"), { recursive: true });
		mkdirSync(join(wt, "packages", "a"), { recursive: true });
		writeFileSync(join(wt, "node_modules", "index.js"), "");
		symlinkSync("../../packages/a", join(wt, "node_modules", "@s", "a"));
		symlinkSync("./not-built", join(wt, "node_modules", "pending"));
		symlinkSync(join(repo, "node_modules"), join(wt, "node_modules", "source"));
		symlinkSync(join(root, "wt-evil"), join(wt, "node_modules", "prefix"));
		symlinkSync("/", join(wt, "node_modules", "root"));
		execFileSync("mkfifo", [join(wt, "node_modules", "pipe")]);
		// The copy itself must still be a plain directory, exactly itself on disk.
		expect(auditCopy(join(wt, "missing"), wt, repo)).toEqual([join(wt, "missing")]);
		symlinkSync(join(wt, "node_modules"), join(wt, "linked"));
		expect(auditCopy(join(wt, "linked"), wt, repo)).toEqual([join(wt, "linked")]);
		expect(auditCopy(join(wt, "node_modules"), wt, repo)).toEqual([
			join(wt, "node_modules", "pipe"),
			join(wt, "node_modules", "prefix"),
			join(wt, "node_modules", "root"),
		]);
	});
});
