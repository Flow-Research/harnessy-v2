import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harnessyEngineToolCanRetry } from "../src/core/extensions/builtin/harnessy-engine.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

/**
 * The suite-wide setup disables the harnessy-engine builtin so upstream
 * fixture tests stay exact; this file re-enables it and covers the builtin:
 * it ships with the loader itself (no configuration), and invokes Executor's
 * stdio MCP entrypoint directly when a tool is first used.
 */
describe("builtin harnessy-engine extension", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let savedEngineFlag: string | undefined;
	let savedRuntimeFlag: string | undefined;
	let savedExecutorCommand: string | undefined;
	let savedExecutorArgs: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `harnessy-builtin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		savedEngineFlag = process.env.HARNESSY_ENGINE;
		savedRuntimeFlag = process.env.HARNESSY_PI_RUNTIME;
		savedExecutorCommand = process.env.HARNESSY_EXECUTOR_COMMAND;
		savedExecutorArgs = process.env.HARNESSY_EXECUTOR_ARGS;
		process.env.HARNESSY_ENGINE = "1";
		process.env.HARNESSY_PI_RUNTIME = "true";
		process.env.HARNESSY_EXECUTOR_COMMAND = join(tempDir, "missing-executor");
		process.env.HARNESSY_EXECUTOR_ARGS = JSON.stringify(["mcp"]);
	});

	afterEach(() => {
		if (savedEngineFlag === undefined) {
			delete process.env.HARNESSY_ENGINE;
		} else {
			process.env.HARNESSY_ENGINE = savedEngineFlag;
		}
		if (savedRuntimeFlag === undefined) {
			delete process.env.HARNESSY_PI_RUNTIME;
		} else {
			process.env.HARNESSY_PI_RUNTIME = savedRuntimeFlag;
		}
		if (savedExecutorCommand === undefined) {
			delete process.env.HARNESSY_EXECUTOR_COMMAND;
		} else {
			process.env.HARNESSY_EXECUTOR_COMMAND = savedExecutorCommand;
		}
		if (savedExecutorArgs === undefined) {
			delete process.env.HARNESSY_EXECUTOR_ARGS;
		} else {
			process.env.HARNESSY_EXECUTOR_ARGS = savedExecutorArgs;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("ships the harnessy tools with the loader in a Harnessy runtime", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const builtin = loader
			.getExtensions()
			.extensions.find((extension) => extension.path === "<inline:harnessy-engine>");
		expect(builtin).toBeDefined();
		expect([...(builtin?.tools.keys() ?? [])].sort()).toEqual([
			"harnessy_execute",
			"harnessy_resume",
			"harnessy_skills",
		]);
		expect(builtin?.commands.has("harnessy")).toBe(true);
	});

	it("is absent from ordinary Pi sessions", async () => {
		delete process.env.HARNESSY_PI_RUNTIME;
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		expect(loader.getExtensions().extensions.some((extension) => extension.path === "<inline:harnessy-engine>")).toBe(
			false,
		);
	});

	it("is absent when explicitly disabled with HARNESSY_ENGINE=0", async () => {
		process.env.HARNESSY_ENGINE = "0";
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		expect(loader.getExtensions().extensions.some((extension) => extension.path === "<inline:harnessy-engine>")).toBe(
			false,
		);
	});

	it("retries only the read-only skills call", () => {
		expect(harnessyEngineToolCanRetry("skills")).toBe(true);
		expect(harnessyEngineToolCanRetry("execute")).toBe(false);
		expect(harnessyEngineToolCanRetry("resume")).toBe(false);
	});

	it("starts the configured Executor MCP entrypoint on first tool use", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const builtin = loader
			.getExtensions()
			.extensions.find((extension) => extension.path === "<inline:harnessy-engine>");
		const execute = builtin?.tools.get("harnessy_execute");
		expect(execute).toBeDefined();

		await expect(
			execute!.definition.execute("test-call", { code: "1" }, undefined, undefined, {} as never),
		).rejects.toThrow(/Bundled Executor could not start/);
	});
});
