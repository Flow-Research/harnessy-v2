import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInstalledBriefGeneration } from "../src/portal/brief-generation.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn(), exists: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, execFileSync: mocks.exec }));
vi.mock("node:fs", () => ({ existsSync: mocks.exists }));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let child: EventEmitter & { stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
const options = {
	homeRoot: "/fixture/home",
	workspaceRoot: "/fixture/workspace",
	env: { PATH: "/bin" },
	nodePath: "/fixture/node",
	cliPath: "/fixture/portal-cli.js",
};
beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process, "platform", { value: "darwin" });
	child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill: vi.fn() });
	mocks.spawn.mockReturnValue(child);
	mocks.exists.mockReturnValue(false);
});
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
	Object.defineProperty(process, "platform", originalPlatform);
});
it("runs only the fixed daily command with scheduler configuration and bounded diagnostics", async () => {
	mocks.exists.mockReturnValue(true);
	mocks.exec.mockReturnValue(JSON.stringify({ AI_PROVIDER: "fixture" }));
	const runner = createInstalledBriefGeneration(options);
	runner.start();
	await Promise.resolve();
	expect(mocks.spawn).toHaveBeenCalledWith(
		options.nodePath,
		expect.arrayContaining(["jarvis", "life", "daily", "--force", "--target", "/fixture/workspace"]),
		expect.objectContaining({
			shell: false,
			cwd: "/fixture/workspace",
			env: { PATH: "/bin", AI_PROVIDER: "fixture", LIFE_ORCHESTRATOR_DAILY_AI_TIMEOUT: "1200" },
		}),
	);
	child.stderr.write("secret diagnostic".repeat(1000));
	child.emit("exit", 0);
	await vi.advanceTimersByTimeAsync(0);
	expect(runner.status()).toMatchObject({ state: "succeeded" });
	expect(JSON.stringify(runner.status())).not.toContain("secret");
});
it.each([null, [], { invalid: 7 }, "not-json"])("rejects malformed scheduler configuration %j", async (value) => {
	mocks.exists.mockReturnValue(true);
	mocks.exec.mockReturnValue(value === "not-json" ? value : JSON.stringify(value));
	const runner = createInstalledBriefGeneration(options);
	runner.start();
	await vi.advanceTimersByTimeAsync(0);
	expect(runner.status().state).toBe("failed");
	expect(mocks.spawn).not.toHaveBeenCalled();
});
it.each(["spawn", "exit", "timeout-output", "deadline"])(
	"reports %s failure without leaking subprocess output",
	async (mode) => {
		const runner = createInstalledBriefGeneration({ ...options, workspaceRoot: undefined });
		runner.start();
		await Promise.resolve();
		expect(mocks.spawn.mock.calls[0]![2].cwd).toBe(options.homeRoot);
		if (mode === "spawn") child.emit("error", new Error("secret"));
		else if (mode === "deadline") await vi.advanceTimersByTimeAsync(25 * 60000);
		else {
			child.stderr.write(mode === "timeout-output" ? "secret timed out" : "secret failed");
			child.emit("exit", 1);
		}
		await vi.advanceTimersByTimeAsync(0);
		expect(runner.status().state).toBe("failed");
		expect(runner.status().message).not.toContain("secret");
		if (mode === "deadline") expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	},
);
