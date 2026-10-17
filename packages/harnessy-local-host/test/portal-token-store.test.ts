/** The portal state directory and install token, on real files in a temporary directory. */
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { bearerSecret, PortalSessions } from "../src/portal/auth.ts";
import {
	PORTAL_TOKEN_FILE,
	PortalStateError,
	preparePortalStateDir,
	readOrCreatePortalInstallToken,
	readPortalInstallToken,
} from "../src/portal/token-store.ts";
import { cleanupPortalFixtures, tempDir } from "./support/portal-fixture.ts";

afterEach(cleanupPortalFixtures);

const code = (run: () => unknown): string | undefined => {
	try {
		run();
		return undefined;
	} catch (error) {
		return error instanceof PortalStateError ? error.code : String(error);
	}
};

describe("portal state directory", () => {
	it("creates a 0700 state and log directory only when asked, and refuses a missing one otherwise", () => {
		const parent = tempDir("state");
		const stateDir = join(parent, "portal");
		expect(code(() => preparePortalStateDir(stateDir, { create: false }))).toBe("state_dir_missing");
		expect(existsSync(stateDir)).toBe(false);
		expect(preparePortalStateDir(stateDir, { create: true })).toBe(stateDir);
		expect(lstatSync(stateDir).mode & 0o777).toBe(0o700);
		expect(lstatSync(join(stateDir, "logs")).mode & 0o777).toBe(0o700);
		// Only the last component is created: a missing parent is refused.
		expect(code(() => preparePortalStateDir(join(parent, "absent", "portal"), { create: true }))).toBe(
			"state_dir_missing",
		);
		expect(code(() => preparePortalStateDir("relative/portal", { create: true }))).toBe("state_dir_not_absolute");
	});

	it("refuses a group-readable, symlinked or non-directory state directory, and an unsafe log directory", () => {
		const parent = tempDir("unsafe");
		const open = join(parent, "open");
		mkdirSync(open, { mode: 0o700 });
		chmodSync(open, 0o750);
		expect(code(() => preparePortalStateDir(open, { create: true }))).toBe("state_dir_unsafe");
		const real = join(parent, "real");
		mkdirSync(real, { mode: 0o700 });
		symlinkSync(real, join(parent, "link"));
		expect(code(() => preparePortalStateDir(join(parent, "link"), { create: true }))).toBe("state_dir_unsafe");
		writeFileSync(join(parent, "file"), "");
		expect(code(() => preparePortalStateDir(join(parent, "file"), { create: false }))).toBe("state_dir_unsafe");
		mkdirSync(join(real, "logs"), { mode: 0o755 });
		chmodSync(join(real, "logs"), 0o755);
		expect(code(() => preparePortalStateDir(real, { create: true }))).toBe("state_dir_unsafe");
	});
});

describe("portal install token", () => {
	it("is created once with mode 0600 and read back unchanged", () => {
		const stateDir = preparePortalStateDir(join(tempDir("token"), "portal"), { create: true });
		expect(code(() => readPortalInstallToken(stateDir))).toBe("token_missing");
		const token = readOrCreatePortalInstallToken(stateDir);
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		const path = join(stateDir, PORTAL_TOKEN_FILE);
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).toBe(`${token}\n`);
		expect(readOrCreatePortalInstallToken(stateDir)).toBe(token);
		expect(readPortalInstallToken(stateDir)).toBe(token);
	});

	it("refuses a symlinked, group-readable, hard-linked, oversize or malformed token file", () => {
		const parent = tempDir("token-unsafe");
		const stateDir = preparePortalStateDir(join(parent, "portal"), { create: true });
		const elsewhere = join(parent, "elsewhere.token");
		writeFileSync(elsewhere, `${"a".repeat(43)}\n`, { mode: 0o600 });
		symlinkSync(elsewhere, join(stateDir, PORTAL_TOKEN_FILE));
		expect(code(() => readOrCreatePortalInstallToken(stateDir))).toBe("token_unsafe");
		expect(code(() => readPortalInstallToken(stateDir))).toBe("token_unsafe");

		const valid = `${"a".repeat(43)}\n`;
		const cases: ReadonlyArray<[string, string, number, string]> = [
			["group-readable", valid, 0o640, "token_unsafe"],
			["oversize", "a".repeat(200), 0o600, "token_unsafe"],
			["malformed", "not a token\n", 0o600, "token_invalid"],
			["hard-linked", valid, 0o600, "token_unsafe"],
		];
		for (const [name, content, mode, expected] of cases) {
			const fresh = preparePortalStateDir(join(parent, `portal-${name}`), { create: true });
			const target = join(fresh, PORTAL_TOKEN_FILE);
			writeFileSync(target, content, { mode });
			chmodSync(target, mode);
			if (name === "hard-linked") linkSync(target, join(fresh, "second-name"));
			expect([name, code(() => readPortalInstallToken(fresh))]).toEqual([name, expected]);
		}
	});

	it("refuses to create a token when another file wins the race to the name", () => {
		const parent = tempDir("token-race");
		const stateDir = preparePortalStateDir(join(parent, "portal"), { create: true });
		// A dangling symlink: the no-follow read sees ELOOP, not ENOENT, and the exclusive create refuses it.
		symlinkSync(join(parent, "absent"), join(stateDir, PORTAL_TOKEN_FILE));
		expect(code(() => readOrCreatePortalInstallToken(stateDir))).toBe("token_unsafe");
		expect(existsSync(join(parent, "absent"))).toBe(false);
	});
});

describe("portal install token creation", () => {
	it("refuses when the token file cannot be created", () => {
		const stateDir = preparePortalStateDir(join(tempDir("token-readonly"), "portal"), { create: true });
		chmodSync(stateDir, 0o500);
		try {
			expect(code(() => readOrCreatePortalInstallToken(stateDir))).toBe("token_unsafe");
		} finally {
			chmodSync(stateDir, 0o700);
		}
	});
});

describe("portal sessions", () => {
	it("parses only a well-formed Bearer header", () => {
		const secret = "b".repeat(43);
		expect(bearerSecret(`Bearer ${secret}`)).toBe(secret);
		expect(bearerSecret(undefined)).toBeUndefined();
		expect(bearerSecret(`bearer ${secret}`)).toBeUndefined();
		expect(bearerSecret(`Bearer ${secret}x`)).toBeUndefined();
	});

	it("refuses a malformed install token and keeps at most 64 page tokens", () => {
		expect(() => new PortalSessions("short")).toThrow("invalid_install_token");
		const clock = { now: 0 };
		const sessions = new PortalSessions("c".repeat(43), () => clock.now);
		expect(sessions.isInstallToken(undefined)).toBe(false);
		expect(sessions.isPageToken(undefined)).toBe(false);
		expect(sessions.exchange("bad")).toBeUndefined();
		const pages = Array.from({ length: 65 }, () => sessions.exchange(sessions.mintCode().secret)!.secret);
		expect(sessions.isPageToken(pages[0])).toBe(false);
		expect(sessions.isPageToken(pages[1])).toBe(true);
		expect(sessions.isPageToken(pages[64])).toBe(true);
		// Expired grants are dropped when the next one is issued.
		clock.now += 9 * 60 * 60 * 1000;
		const code = sessions.mintCode().secret;
		expect(sessions.exchange(code)).toBeDefined();
		expect(sessions.isPageToken(pages[64])).toBe(false);
	});
});
