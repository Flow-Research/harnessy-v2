import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import type { ExtensionAPI } from "../../../src/index.ts";

const noop: (pi: ExtensionAPI) => void = () => {};

function userInlineExtensions(loader: DefaultResourceLoader) {
	return loader.getExtensions().extensions.filter((extension) => extension.path !== "<inline:plan-mode>");
}

describe("inline extension naming", () => {
	const roots: string[] = [];

	function fixture(name: string) {
		const root = join(tmpdir(), `pi-inline-naming-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		roots.push(root);
		return { root, cwd, agentDir };
	}

	beforeEach(() => {
		roots.length = 0;
	});

	afterEach(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root && existsSync(root)) {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it("displays bare factories as <inline:N>", async () => {
		const { cwd, agentDir } = fixture("bare");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [noop, noop],
		});

		await loader.reload();

		const extensions = userInlineExtensions(loader);

		expect(extensions).toHaveLength(2);
		expect(extensions[0].path).toBe("<inline:1>");
		expect(extensions[1].path).toBe("<inline:2>");
	});

	it("displays named wrappers as <inline:name>", async () => {
		const { cwd, agentDir } = fixture("named");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [
				{ name: "my-provider", factory: noop },
				{ name: "my-commands", factory: noop },
			],
		});

		await loader.reload();

		const extensions = userInlineExtensions(loader);

		expect(extensions).toHaveLength(2);
		expect(extensions[0].path).toBe("<inline:my-provider>");
		expect(extensions[1].path).toBe("<inline:my-commands>");
	});

	it("supports mixed bare and named factories", async () => {
		const { cwd, agentDir } = fixture("mixed");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [noop, { name: "named-ext", factory: noop }, noop],
		});

		await loader.reload();

		const extensions = userInlineExtensions(loader);

		expect(extensions).toHaveLength(3);
		expect(extensions[0].path).toBe("<inline:1>");
		expect(extensions[1].path).toBe("<inline:named-ext>");
		expect(extensions[2].path).toBe("<inline:3>");
	});
});
