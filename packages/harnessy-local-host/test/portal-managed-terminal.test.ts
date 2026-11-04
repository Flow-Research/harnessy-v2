import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ManagedTerminal } from "../src/portal/managed-terminal.ts";

it.each([true, false])(
	"recovers a restored starting agent (backend survives: %s) and verifies identity before ending it",
	async (survives) => {
		const root = mkdtempSync(join(tmpdir(), "hsy-crash-"));
		const bin = join(root, "bin");
		mkdirSync(bin);
		const argsFile = join(root, "args.txt");
		writeFileSync(join(bin, "hsy"), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argsFile}'\nexec /bin/cat\n`);
		chmodSync(join(bin, "hsy"), 0o700);
		const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
		let manager = new ManagedTerminal(join(root, "state"), root, env);
		const session = manager.session;
		const herdr = (...args: string[]) =>
			execFileSync("herdr", ["--session", session, ...args], {
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		try {
			const { id } = (await manager.action({
				action: "launch",
				runner: "hsy",
				title: "Crash fixture",
				instructions: "Fixture only",
				isolation: "existing",
			})) as { id: string };
			await expect
				.poll(() => {
					try {
						return readFileSync(argsFile, "utf8");
					} catch {
						return "";
					}
				})
				.toContain("--session-id");
			const row = manager.records.get(id)!;
			const conversation = row.conversation!;
			row.state = "starting";
			expect(manager.list().sessions[0]?.state).toBe("starting");
			writeFileSync(join(root, "state", "sessions.json"), JSON.stringify([...manager.records.values()]));
			manager.close();
			if (!survives) {
				herdr("server", "stop");
				await expect
					.poll(() => {
						try {
							herdr("pane", "list");
							return true;
						} catch {
							return false;
						}
					})
					.toBe(false);
			}
			manager = new ManagedTerminal(join(root, "state"), root, env);
			expect(manager.list().sessions[0]).toMatchObject({
				state: survives ? "running" : "interrupted",
				recoverable: true,
			});
			if (!survives) {
				await expect(manager.action({ action: "close", id })).rejects.toThrow("terminal_end_unverified");
				expect(manager.records.get(id)?.state).toBe("interrupted");
				await manager.action({ action: "resume", id });
				await expect.poll(() => readFileSync(argsFile, "utf8")).toContain(`--session\n${conversation}`);
			} else {
				expect(readFileSync(argsFile, "utf8").match(/--session-id/g)).toHaveLength(1);
			}
			await manager.action({ action: "attach", id }, "fixture");
			manager.streams.get(id)!.child.kill();
			await expect.poll(() => manager.records.get(id)?.state).toBe("interrupted");
			const current = manager.records.get(id)!;
			const stamp = current.processStamp!;
			const pane = current.pane!;
			const terminal = current.terminal!;
			// PID reuse or a replaced pane must never terminate an unrelated process.
			current.processStamp = "1:unrelated process";
			await expect(manager.action({ action: "close", id })).rejects.toThrow("terminal_end_unverified");
			expect(herdr("pane", "list")).toContain(pane);
			expect(current.state).toBe("interrupted");
			current.processStamp = stamp;
			current.terminal = "unrelated-terminal";
			await expect(manager.action({ action: "close", id })).rejects.toThrow("terminal_end_unverified");
			expect(herdr("pane", "list")).toContain(pane);
			current.terminal = terminal;
			const backend = manager as unknown as { herdr(args: string[]): string };
			const execute = backend.herdr.bind(manager);
			const missingPane = vi
				.spyOn(backend, "herdr")
				.mockImplementation((args) =>
					args[0] === "pane" && args[1] === "list" ? JSON.stringify({ result: { panes: [] } }) : execute(args),
				);
			await expect(manager.action({ action: "close", id })).rejects.toThrow("terminal_end_unverified");
			missingPane.mockRestore();
			expect(current.state).toBe("interrupted");
			expect(herdr("pane", "list")).toContain(pane);
			let hidden = false;
			const incompleteClose = vi.spyOn(backend, "herdr").mockImplementation((args) => {
				if (args[0] === "pane" && args[1] === "close") {
					hidden = true;
					return "{}";
				}
				if (hidden && args[0] === "pane" && args[1] === "list") return JSON.stringify({ result: { panes: [] } });
				return execute(args);
			});
			await expect(manager.action({ action: "close", id })).rejects.toThrow("terminal_end_unverified");
			incompleteClose.mockRestore();
			expect(current.state).toBe("interrupted");
			expect(herdr("pane", "list")).toContain(pane);
			await manager.action({ action: "close", id });
			expect(current.state).toBe("ended");
			expect(herdr("pane", "list")).not.toContain(pane);
			await expect
				.poll(() => {
					try {
						process.kill(Number(stamp.split(":", 1)[0]), 0);
						return true;
					} catch {
						return false;
					}
				})
				.toBe(false);
			expect(manager.list().sessions).toHaveLength(0);
		} finally {
			manager.close();
			try {
				herdr("server", "stop");
			} catch {
				/* Fixture already stopped. */
			}
			rmSync(root, { recursive: true, force: true });
		}
	},
	20000,
);

it("preserves a real shell across manager restart and enforces input ownership", async () => {
	const root = mkdtempSync(join(tmpdir(), "hsy-managed-"));
	let manager = new ManagedTerminal(root, root);
	const session = manager.session;
	try {
		const request = { action: "create", requestId: randomUUID() };
		const created = (await manager.action(request)) as { id: string };
		expect(await manager.action(request)).toEqual(created);
		expect(manager.list().sessions).toHaveLength(1);
		expect(await manager.action({ action: "attach", id: created.id }, "one")).toEqual({ controlling: true });
		expect(await manager.action({ action: "attach", id: created.id }, "two")).toEqual({ controlling: false });
		await expect(manager.action({ action: "input", id: created.id, data: "exit\n" }, "two")).rejects.toThrow(
			"terminal_observer_take_control",
		);
		await new Promise((done) => setTimeout(done, 500));
		await manager.action(
			{ action: "input", id: created.id, data: "export HSY_SURVIVES=42; printf 'ready_%s\\n' yes\n" },
			"one",
		);
		await expect
			.poll(() => Buffer.from(manager.read(created.id, 0).data, "base64").toString(), { timeout: 5000 })
			.toContain("ready_yes");
		manager.close();
		manager = new ManagedTerminal(root, root);
		expect(await manager.action({ action: "attach", id: created.id }, "three")).toEqual({ controlling: true });
		await new Promise((done) => setTimeout(done, 500));
		await manager.action(
			{ action: "input", id: created.id, data: "printf 'survived=%s\\n' \"$HSY_SURVIVES\"\n" },
			"three",
		);
		await expect
			.poll(() => Buffer.from(manager.read(created.id, 0).data, "base64").toString(), { timeout: 5000 })
			.toContain("survived=42");
		await manager.action({ action: "close", id: created.id });
		expect(manager.list().sessions).toHaveLength(0);
	} finally {
		manager.close();
		try {
			execFileSync("herdr", ["--session", session, "server", "stop"], { stdio: "ignore" });
		} catch {
			/* Already stopped. */
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);

it.each(["fixture", ""])(
	"launches once in project '%s' with literal Unicode context and resumes an exact fake-agent conversation after backend loss",
	async (selectedProject) => {
		const root = mkdtempSync(join(tmpdir(), "hsy-agent-"));
		const bin = join(root, "bin");
		mkdirSync(bin);
		const project = join(root, "project");
		mkdirSync(project);
		mkdirSync(join(root, ".harnessy"));
		writeFileSync(
			join(root, ".harnessy/workspace.json"),
			JSON.stringify({ projects: [{ id: "fixture", path: "project" }] }),
		);
		const args = join(root, "args.txt");
		writeFileSync(join(bin, "hsy"), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${args}'\nexec /bin/cat\n`);
		chmodSync(join(bin, "hsy"), 0o700);
		const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
		let manager = new ManagedTerminal(join(root, "state"), root, env);
		const session = manager.session;
		try {
			const request = {
				action: "launch",
				requestId: randomUUID(),
				runner: "hsy",
				title: "Étude Yorùbá",
				instructions: "Explain العربية",
				context: "$(touch /never) `literal`",
				source: "2026-11-03 · Reading",
				project: selectedProject,
				isolation: "existing",
			};
			await expect(manager.action({ ...request, schemaVersion: 900 })).rejects.toThrow(
				"unsupported_terminal_version",
			);
			await expect(manager.action({ ...request, project: "missing" })).rejects.toThrow("project_not_found");
			await expect(manager.action({ ...request, project: "", isolation: "worktree" })).rejects.toThrow(
				"worktree_requires_project",
			);
			expect(manager.list().sessions).toHaveLength(0);
			const [a, b] = (await Promise.all([manager.action(request), manager.action(request)])) as { id: string }[];
			expect(a).toEqual(b);
			const id = a!.id;
			expect(manager.list().sessions[0]).toMatchObject({
				project: selectedProject,
				cwd: selectedProject ? realpathSync(project) : root,
			});
			await expect
				.poll(
					() => {
						try {
							return readFileSync(args, "utf8");
						} catch {
							return "";
						}
					},
					{ timeout: 8000 },
				)
				.toContain("--session-id");
			const original = readFileSync(args, "utf8");
			const conversation = original.split("\n")[1]!;
			expect(readFileSync(join(root, "state", `${id}.txt`), "utf8")).toContain(request.context);
			await expect(manager.action({ ...request, instructions: "different" })).rejects.toThrow("launch_conflict");
			expect(original).not.toContain("dangerously");
			manager.close();
			execFileSync("herdr", ["--session", session, "server", "stop"], { stdio: "ignore" });
			await new Promise((done) => setTimeout(done, 500));
			manager = new ManagedTerminal(join(root, "state"), root, env);
			expect(manager.list().sessions[0]?.state).toBe("interrupted");
			await manager.action({ action: "resume", id });
			await expect.poll(() => readFileSync(args, "utf8"), { timeout: 8000 }).toContain(`--session\n${conversation}`);
			expect(readFileSync(args, "utf8").match(/carry out/g)).toHaveLength(1);
			await expect(manager.action({ action: "resume", id })).rejects.toThrow("terminal_already_running");
			manager.close();
			execFileSync("herdr", ["--session", session, "server", "stop"], { stdio: "ignore" });
			await new Promise((done) => setTimeout(done, 500));
			manager = new ManagedTerminal(join(root, "state"), root, env);
			expect(manager.list().sessions[0]?.state).toBe("interrupted");
			const backend = manager as unknown as { herdr(args: string[]): string };
			const execute = backend.herdr.bind(manager);
			const failure = vi.spyOn(backend, "herdr").mockImplementation((args) => {
				if (args[0] === "pane" && args[1] === "run") throw new Error("fixture_resume_failure");
				return execute(args);
			});
			await expect(manager.action({ action: "resume", id })).rejects.toThrow("fixture_resume_failure");
			failure.mockRestore();
			expect(manager.list().sessions[0]).toMatchObject({
				state: "failed",
				error: "resume_failed_inspect_before_retry",
			});
			await manager.action({ action: "close", id });
		} finally {
			manager.close();
			try {
				execFileSync("herdr", ["--session", session, "server", "stop"], { stdio: "ignore" });
			} catch {
				/* Already stopped. */
			}
			rmSync(root, { recursive: true, force: true });
		}
	},
	20000,
);
