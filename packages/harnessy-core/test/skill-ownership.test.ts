import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { installOwnedSkill } from "../src/runtime/skill-ownership.ts";

it("stages owned upgrades and preserves the previous version if staging fails", async () => {
	const home = await mkdtemp(join(tmpdir(), "hsy-owned-"));
	try {
		const source = join(home, "source");
		const target = join(home, "target");
		await mkdir(source);
		await writeFile(join(source, "SKILL.md"), "version one");
		await installOwnedSkill(source, target, "bundled:fixture");
		await writeFile(join(source, "SKILL.md"), "version two");
		await installOwnedSkill(source, target, "bundled:fixture");
		expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("version two");
		await expect(installOwnedSkill(join(home, "absent"), target, "bundled:fixture")).rejects.toThrow();
		expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("version two");
		await expect(installOwnedSkill(source, target, "project:other")).rejects.toThrow("ownership is unverified");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

for (const kind of ["unmarked", "invalid-marker", "linked-marker", "linked-directory", "dangling-link"]) {
	it(`refuses ambiguous ${kind} ownership without changing the target`, async () => {
		const home = await mkdtemp(join(tmpdir(), "hsy-owned-"));
		try {
			const source = join(home, "source");
			const actual = join(home, "actual");
			const target = join(home, "target");
			await mkdir(source);
			await mkdir(actual);
			await writeFile(join(source, "SKILL.md"), "new");
			await writeFile(join(actual, "keep"), "independent");
			if (kind === "linked-directory" || kind === "dangling-link")
				await symlink(kind === "linked-directory" ? actual : join(home, "missing"), target);
			else {
				await mkdir(target);
				await writeFile(join(target, "keep"), "independent");
				if (kind === "invalid-marker") await writeFile(join(target, ".harnessy-install.json"), "{broken");
				if (kind === "linked-marker") {
					await writeFile(
						join(home, "marker"),
						JSON.stringify({ version: 1, owner: "harnessy", sourceId: "bundled:fixture" }),
					);
					await symlink(join(home, "marker"), join(target, ".harnessy-install.json"));
				}
			}
			await expect(installOwnedSkill(source, target, "bundled:fixture")).rejects.toThrow("ownership is unverified");
			expect(await readFile(join(actual, "keep"), "utf8")).toBe("independent");
			if (!kind.includes("link")) expect(await readFile(join(target, "keep"), "utf8")).toBe("independent");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
}
