import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gwsCalendarProvider } from "../src/jarvis/calendar/gws-provider.ts";

describe.runIf(process.platform !== "win32")("Google calendar process boundary", () => {
	let root: string;
	let config: string;
	let executable: string;
	const account = "calendar-owner@example.test";
	const id = "a".repeat(64);
	const block = {
		block_id: "block",
		task_id: "task",
		task_title: "Plan",
		start: "2030-01-01T10:00:00Z",
		end: "2030-01-01T10:30:00Z",
		estimated_minutes: 30,
		reason: "Focus",
	};
	const event = {
		id,
		status: "confirmed",
		summary: "Jarvis: Plan",
		description: "Task ID: task\nReason: Focus",
		start: { dateTime: block.start },
		end: { dateTime: block.end },
	};
	const response = (value: unknown, exit = 0) =>
		writeFileSync(join(config, "response.json"), JSON.stringify({ value, exit }));
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-calendar-gws-")));
		config = join(root, "config");
		mkdirSync(config, { mode: 0o700 });
		executable = join(root, "synthetic-gws");
		writeFileSync(
			executable,
			`#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const config = process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR;
writeFileSync(config + '/request.json', JSON.stringify({ args: process.argv.slice(2), inheritedToken: Boolean(process.env.GOOGLE_WORKSPACE_CLI_TOKEN), inheritedCredentials: Boolean(process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE) }));
const response = JSON.parse(readFileSync(config + '/response.json', 'utf8'));
if (response.exit) { console.error('PRIVATE_PROVIDER_DETAIL'); process.exit(response.exit); }
console.log(JSON.stringify(response.value));
`,
			{ mode: 0o700 },
		);
		vi.stubEnv("HOME", root);
		vi.stubEnv(
			"NODE_OPTIONS",
			`--import=${fileURLToPath(new URL("../../harnessy-local-host/test/support/fixture-network-guard.mjs", import.meta.url))}`,
		);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("verifies the owner and sends exact structured event arguments", async () => {
		const provider = gwsCalendarProvider(executable, config, account);
		response({ id: account });
		await provider.verifyIdentity();
		response({ id });
		expect(await provider.createEvent(block, id)).toBe(id);
		const request = JSON.parse(readFileSync(join(config, "request.json"), "utf8"));
		expect(request.args).toEqual([
			"calendar",
			"events",
			"insert",
			"--params",
			JSON.stringify({ calendarId: account }),
			"--json",
			JSON.stringify({
				id,
				summary: event.summary,
				start: event.start,
				end: event.end,
				description: event.description,
			}),
			"--format",
			"json",
		]);
		response({ ...event, start: { dateTime: "2030-01-01T11:00:00+01:00" } });
		expect(await provider.verifyEvent(block, id)).toBe(true);
	});

	it.each([
		{ id: "wrong" },
		{ status: "cancelled" },
		{ summary: "changed" },
		{ description: "changed" },
		{ start: null },
		{ start: {} },
		{ start: { dateTime: 0 } },
		{ start: { dateTime: "2030-01-01T11:00:00Z" } },
		{ end: null },
		{ end: {} },
		{ end: { dateTime: 0 } },
		{ end: { dateTime: "invalid" } },
	])("does not reconcile a changed or malformed event: %j", async (change) => {
		response({ ...event, ...change });
		expect(await gwsCalendarProvider(executable, config, account).verifyEvent(block, id)).toBe(false);
	});

	it.each([null, [], "not an object"])("rejects malformed provider output: %j", async (value) => {
		response(value);
		await expect(gwsCalendarProvider(executable, config, account).verifyIdentity()).rejects.toThrow(
			"output withheld",
		);
	});

	it("sanitizes provider failures and rejects wrong account or receipt identity", async () => {
		const provider = gwsCalendarProvider(executable, config, account);
		response({}, 2);
		await expect(provider.verifyIdentity()).rejects.toThrow(
			"Google calendar command failed; provider output withheld",
		);
		response({ id: "someone-else@example.test" });
		await expect(provider.verifyIdentity()).rejects.toThrow("approved account");
		await expect(provider.createEvent(block, id)).rejects.toThrow("exact requested event");
	});

	it("rejects unsafe setup and executable replacement", async () => {
		expect(() => gwsCalendarProvider("relative", config, account)).toThrow("Explicit");
		expect(() => gwsCalendarProvider(executable, "relative", account)).toThrow("Explicit");
		expect(() => gwsCalendarProvider(executable, config, "invalid")).toThrow("Explicit");
		chmodSync(config, 0o755);
		expect(() => gwsCalendarProvider(executable, config, account)).toThrow("owner-only");
		chmodSync(config, 0o700);
		const provider = gwsCalendarProvider(executable, config, account);
		writeFileSync(executable, "changed");
		await expect(provider.verifyIdentity()).rejects.toThrow("executable changed");
	});

	it("does not let ambient credentials override the explicitly selected configuration", async () => {
		vi.stubEnv("GOOGLE_WORKSPACE_CLI_TOKEN", "synthetic-override");
		vi.stubEnv("GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE", join(root, "other-account.json"));
		response({ id: account });
		await gwsCalendarProvider(executable, config, account).verifyIdentity();
		const request = JSON.parse(readFileSync(join(config, "request.json"), "utf8"));
		expect(request.inheritedToken).toBe(false);
		expect(request.inheritedCredentials).toBe(false);
	});
});
