import { describe, expect, it } from "@effect/vitest";

import { configureHsyRuntimeEnv } from "../src/hsy-runtime-env.ts";

describe("configureHsyRuntimeEnv", () => {
	it("defaults all host paths and identity to Harnessy", () => {
		const env: NodeJS.ProcessEnv = {};

		expect(configureHsyRuntimeEnv(env, "/home/tester")).toBe("/home/tester/.hsy/agent");
		expect(env).toMatchObject({
			HSY_CODING_AGENT_DIR: "/home/tester/.hsy/agent",
			HSY_CONFIG_DIR: ".hsy",
			PI_CODING_AGENT_DIR: "/home/tester/.hsy/agent",
			PI_CONFIG_DIR: ".hsy",
			PI_APP_NAME: "hsy",
			PI_APP_TITLE: "Harnessy",
			PI_APP_DESCRIPTION: "Harnessy agent-first context engine",
			HARNESSY_PI_RUNTIME: "true",
		});
	});

	it("preserves a Harnessy override and replaces inherited Pi paths", () => {
		const env: NodeJS.ProcessEnv = {
			HSY_CODING_AGENT_DIR: "/tmp/custom-hsy",
			PI_CODING_AGENT_DIR: "/home/tester/.pi/agent",
			PI_CONFIG_DIR: ".pi",
			EXECUTOR_DATA_DIR: "/tmp/executor-owned",
		};

		expect(configureHsyRuntimeEnv(env, "/home/tester")).toBe("/tmp/custom-hsy");
		expect(env.PI_CODING_AGENT_DIR).toBe("/tmp/custom-hsy");
		expect(env.PI_CONFIG_DIR).toBe(".hsy");
		expect(env.EXECUTOR_DATA_DIR).toBe("/tmp/executor-owned");
		expect(env.HARNESSY_ENGINE_DATA_DIR).toBeUndefined();
	});
});
