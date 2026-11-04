import type * as ChildProcess from "node:child_process";
import type * as FsPromises from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";

const mocks = vi.hoisted(() => ({ access: vi.fn(), spawn: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({
	...(await original<typeof FsPromises>()),
	access: mocks.access,
}));
vi.mock("child_process", async (original) => ({
	...(await original<typeof ChildProcess>()),
	spawn: mocks.spawn,
}));

afterEach(() => vi.resetAllMocks());

it("does not spawn a command cancelled while its directory check is pending", async () => {
	let finishAccess!: () => void;
	mocks.access.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				finishAccess = resolve;
			}),
	);
	mocks.spawn.mockImplementation(() => {
		throw new Error("unexpected command spawn");
	});
	const controller = new AbortController();
	const pending = createLocalBashOperations({ shellPath: "/bin/sh" }).exec("unused", "/fixture", {
		onData: () => {},
		signal: controller.signal,
	});
	expect(mocks.access).toHaveBeenCalledOnce();
	controller.abort();
	finishAccess();
	await expect(pending).rejects.toThrow("aborted");
	expect(mocks.spawn).not.toHaveBeenCalled();
});
