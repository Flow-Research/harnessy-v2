import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

describe("built-in plan mode loader", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-plan-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("ships plan mode without user extension configuration", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const builtin = loader.getExtensions().extensions.find((extension) => extension.path === "<inline:plan-mode>");
		expect(builtin).toBeDefined();
		expect([...builtin!.commands.keys()]).toEqual(["plan"]);
		expect(builtin!.tools.has("enter_plan_mode")).toBe(true);
		expect(builtin!.flags.has("plan")).toBe(true);
		expect(KeybindingsManager.create(agentDir).getEffectiveConfig()["app.plan.toggle"]).toBe("ctrl+alt+p");
	});

	it("remains available when user extensions are disabled", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true });
		await loader.reload();

		expect(loader.getExtensions().extensions.some((extension) => extension.path === "<inline:plan-mode>")).toBe(true);
	});

	it("loads the former example path as a no-op compatibility shim", async () => {
		const legacyPath = fileURLToPath(new URL("../examples/extensions/plan-mode/index.ts", import.meta.url));
		const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [legacyPath] });
		await loader.reload();

		const result = loader.getExtensions();
		const legacy = result.extensions.find((extension) => extension.path === legacyPath);
		expect(legacy).toBeDefined();
		expect(legacy!.commands.size).toBe(0);
		expect(legacy!.tools.size).toBe(0);
		expect(legacy!.flags.size).toBe(0);
		expect(result.errors).toEqual([]);
	});
});
