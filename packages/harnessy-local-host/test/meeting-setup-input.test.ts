import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readMeetingSetupInput } from "../src/meeting-setup-input.ts";

const roots: string[] = [];
const fixture = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "meeting-setup-input-"));
	roots.push(root);
	chmodSync(root, 0o700);
	const statePath = join(root, "meeting-state");
	mkdirSync(statePath, { mode: 0o700 });
	const path = join(root, "input.json");
	const input = {
		kind: "harnessy.meeting-publication.connection-setup.v1",
		statePath,
		tenant: "fixture-tenant",
		subject: "fixture-owner",
		google: {
			owner: "user",
			name: "meeting-google",
			clientOwner: "user",
			clientSlug: "meeting-google-client",
			expectedOwnerEmail: "owner@example.test",
			clientId: "synthetic-client-id",
			clientSecret: "synthetic-client-secret",
		},
		discord: {
			owner: "user",
			name: "meeting-discord",
			expectedChannelId: "123456789",
			token: "synthetic-discord-secret",
		},
	};
	writeFileSync(path, JSON.stringify(input), { mode: 0o600 });
	return { root, path, input };
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("one-time meeting setup protected input", () => {
	it("derives separate native directories without putting secrets into connection config", () => {
		const { path, input } = fixture();
		const result = readMeetingSetupInput(["--input", path]);
		expect(result.config.directory).toBe(join(input.statePath, "native-executor"));
		expect(result.config.credentialDirectory).toBe(join(input.statePath, "native-credentials"));
		expect(result.config.google.expectedOwnerEmail).toBe(input.google.expectedOwnerEmail);
		expect(result.config.discord.expectedChannelId).toBe(input.discord.expectedChannelId);
		expect(result.googleClient.clientSecret).toBe(input.google.clientSecret);
		expect(result.discordToken).toBe(input.discord.token);
		expect(JSON.stringify(result.config)).not.toContain("synthetic");
	});

	it.each(
		[
			[],
			["--token", "synthetic-discord-secret"],
			["--input", "relative.json"],
			["--input", "/missing", "--extra"],
		].map((args) => ({ args })),
	)("rejects unsupported argv without echoing values: %j", ({ args }) => {
		expect(() => readMeetingSetupInput(args)).toThrow("meeting_setup_input_invalid");
	});

	it.each([
		"public-file",
		"symlink",
		"hardlink",
		"public-state",
		"state-symlink",
		"oversized",
		"invalid-json",
		"invalid-utf8",
		"unknown-key",
		"bad-channel",
	])("rejects %s while redacting private input", (mode) => {
		const { root, path, input } = fixture();
		let target = path;
		if (mode === "public-file") chmodSync(path, 0o644);
		if (mode === "symlink") {
			target = join(root, "linked.json");
			symlinkSync(path, target);
		}
		if (mode === "hardlink") linkSync(path, join(root, "other.json"));
		if (mode === "public-state") chmodSync(input.statePath, 0o755);
		if (mode === "state-symlink") {
			const linked = join(root, "linked-state");
			symlinkSync(input.statePath, linked);
			writeFileSync(path, JSON.stringify({ ...input, statePath: linked }));
		}
		if (mode === "oversized") writeFileSync(path, "synthetic-secret".repeat(2000));
		if (mode === "invalid-json") writeFileSync(path, "synthetic-secret{");
		if (mode === "invalid-utf8") writeFileSync(path, Buffer.from([0xff]));
		if (mode === "unknown-key") writeFileSync(path, JSON.stringify({ ...input, token: "synthetic-secret" }));
		if (mode === "bad-channel") {
			writeFileSync(path, JSON.stringify({ ...input, discord: { ...input.discord, expectedChannelId: "bad" } }));
		}
		let failure: unknown;
		try {
			readMeetingSetupInput(["--input", target]);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).toBe("Error: meeting_setup_input_invalid");
		expect((failure as Error).cause).toBeUndefined();
	});
});
