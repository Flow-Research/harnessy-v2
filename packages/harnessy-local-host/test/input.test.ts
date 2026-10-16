import type { ReadPosition } from "node:fs";
import fs, {
	appendFileSync,
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { exportLocalHostPlan, readLocalHostStatus } from "../src/application.ts";
import {
	LocalHostInputError,
	readAndVerifyPlanEnvelope,
	readLocalHostArtifactDigest,
	readLocalHostConfig,
} from "../src/input.ts";
import { formatPlanEnvelope } from "../src/schema.ts";

const roots: Array<string> = [];

const configValue = (root: string) => ({
	enabled: true,
	project: "alpha",
	sourcePath: join(root, "source"),
	statePath: join(root, "state"),
	backfillDays: 365,
	cutoverDate: "2026-01-01",
	maxFileBytes: 32_000,
	maxFiles: 100,
	leaseSeconds: 60,
	reminderSeconds: 3_600,
	reviewHost: "127.0.0.1",
	reviewPort: 0,
	reviewSessionSeconds: 900,
	reviewMaxSessions: 64,
	reviewMaxBodyBytes: 4_096,
	googleOwnerEmail: "owner@example.test",
	googleDriveFolder: "folder-id",
	discordChannelId: "channel-id",
});

type ConfigValue = Omit<ReturnType<typeof configValue>, "sourcePath" | "statePath"> & {
	sourcePath: string | null;
	statePath: string | null;
};

const makeFixture = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-local-host-input-"));
	roots.push(root);
	chmodSync(root, 0o700);
	const sourcePath = join(root, "source");
	const statePath = join(root, "state");
	mkdirSync(sourcePath, { mode: 0o755 });
	mkdirSync(statePath, { mode: 0o700 });
	const configPath = join(root, "config.json");
	const artifactPath = join(root, "local-host.js");
	writeFileSync(configPath, `${JSON.stringify(configValue(root))}\n`, { mode: 0o600 });
	// A TypeScript source artifact need not be executable.
	writeFileSync(artifactPath, "export {};\n", { mode: 0o644 });
	return { artifactPath, configPath, root, sourcePath, statePath };
};

type Fixture = ReturnType<typeof makeFixture>;

const rewriteConfig = (fixture: Fixture, overrides: Partial<ConfigValue>) => {
	writeFileSync(fixture.configPath, `${JSON.stringify({ ...configValue(fixture.root), ...overrides })}\n`);
	chmodSync(fixture.configPath, 0o600);
};

const expectInputError = (read: () => unknown, code: LocalHostInputError["code"]) => {
	let caught: unknown;
	try {
		read();
	} catch (cause) {
		caught = cause;
	}
	expect(caught).toBeInstanceOf(LocalHostInputError);
	expect(caught).toMatchObject({ code, message: "Local-host input validation failed" });
};

const installReadFault = (fault: () => void) => {
	const realReadSync = fs.readSync;
	let triggered = false;
	fs.readSync = ((
		descriptor: number,
		buffer: NodeJS.ArrayBufferView,
		offset: number,
		length: number,
		position: ReadPosition | null,
	) => {
		const count = realReadSync(descriptor, buffer, offset, length, position);
		if (!triggered && count > 0) {
			triggered = true;
			fault();
		}
		return count;
	}) as typeof fs.readSync;
	syncBuiltinESMExports();
	return {
		wasTriggered: () => triggered,
		restore: () => {
			fs.readSync = realReadSync;
			syncBuiltinESMExports();
		},
	};
};

const replaceProcessProperty = (key: "geteuid" | "platform", value: unknown) => {
	const descriptor = Object.getOwnPropertyDescriptor(process, key);
	if (descriptor === undefined) throw new Error(`Expected process.${key} descriptor`);
	Object.defineProperty(process, key, { ...descriptor, value });
	return () => Object.defineProperty(process, key, descriptor);
};

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local-host input safety", () => {
	it.each([0o400, 0o600])("accepts a private config mode %s and a non-executable artifact", (mode) => {
		const fixture = makeFixture();
		chmodSync(fixture.configPath, mode);
		const loaded = readLocalHostConfig(fixture.configPath);
		expect(loaded.config.sourcePath).toBe(fixture.sourcePath);
		expect(loaded.config.statePath).toBe(fixture.statePath);
		expect(readLocalHostArtifactDigest(fixture.artifactPath)).toMatchObject({
			path: fixture.artifactPath,
			sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
		});
	});

	it.each([
		{
			label: "group-readable private config",
			change: (fixture: Fixture) => chmodSync(fixture.configPath, 0o640),
			read: (fixture: Fixture) => readLocalHostConfig(fixture.configPath),
		},
		{
			label: "group-writable artifact",
			change: (fixture: Fixture) => chmodSync(fixture.artifactPath, 0o660),
			read: (fixture: Fixture) => readLocalHostArtifactDigest(fixture.artifactPath),
		},
		{
			label: "owner-unreadable artifact",
			change: (fixture: Fixture) => chmodSync(fixture.artifactPath, 0o200),
			read: (fixture: Fixture) => readLocalHostArtifactDigest(fixture.artifactPath),
		},
		{
			label: "group-writable source root",
			change: (fixture: Fixture) => chmodSync(fixture.sourcePath, 0o775),
			read: (fixture: Fixture) => readLocalHostConfig(fixture.configPath),
		},
		{
			label: "non-traversable source root",
			change: (fixture: Fixture) => chmodSync(fixture.sourcePath, 0o600),
			read: (fixture: Fixture) => readLocalHostConfig(fixture.configPath),
		},
		{
			label: "read-only state root",
			change: (fixture: Fixture) => chmodSync(fixture.statePath, 0o500),
			read: (fixture: Fixture) => readLocalHostConfig(fixture.configPath),
		},
	])("rejects a $label with a content-free error", ({ change, read }) => {
		const fixture = makeFixture();
		change(fixture);
		expectInputError(() => read(fixture), "unsafe_input");
	});

	it.each(["config", "artifact"] as const)("rejects a hard-linked %s leaf", (role) => {
		const fixture = makeFixture();
		const path = role === "config" ? fixture.configPath : fixture.artifactPath;
		linkSync(path, join(fixture.root, `${role}-link`));
		expectInputError(
			() => (role === "config" ? readLocalHostConfig(path) : readLocalHostArtifactDigest(path)),
			"unsafe_input",
		);
	});

	it("rejects symlinked and writable ancestors", () => {
		const symlinkFixture = makeFixture();
		const protectedDirectory = join(symlinkFixture.root, "protected");
		const alias = join(symlinkFixture.root, "alias");
		mkdirSync(protectedDirectory, { mode: 0o700 });
		const nestedConfig = join(protectedDirectory, "config.json");
		writeFileSync(nestedConfig, `${JSON.stringify(configValue(symlinkFixture.root))}\n`, { mode: 0o600 });
		symlinkSync(protectedDirectory, alias, "dir");
		expectInputError(() => readLocalHostConfig(join(alias, "config.json")), "unsafe_input");

		const writableFixture = makeFixture();
		chmodSync(writableFixture.root, 0o770);
		expectInputError(() => readLocalHostConfig(writableFixture.configPath), "unsafe_input");
	});

	it.each([
		{ label: "source alias", role: "source" as const, missingDescendant: false },
		{ label: "missing source below an alias", role: "source" as const, missingDescendant: true },
		{ label: "state alias", role: "state" as const, missingDescendant: false },
	])("rejects a configured $label", ({ role, missingDescendant }) => {
		const fixture = makeFixture();
		const target = role === "source" ? fixture.sourcePath : fixture.statePath;
		const alias = join(fixture.root, `${role}-alias`);
		symlinkSync(target, alias, "dir");
		const configuredPath = missingDescendant ? join(alias, "missing") : alias;
		rewriteConfig(fixture, role === "source" ? { sourcePath: configuredPath } : { statePath: configuredPath });
		expectInputError(() => readLocalHostConfig(fixture.configPath), "unsafe_input");
	});

	it("accepts null or missing configured roots without creating them", () => {
		const nullFixture = makeFixture();
		rewriteConfig(nullFixture, { sourcePath: null, statePath: null });
		expect(readLocalHostConfig(nullFixture.configPath).config).toMatchObject({
			sourcePath: null,
			statePath: null,
		});

		const missingFixture = makeFixture();
		rmSync(missingFixture.sourcePath, { recursive: true });
		rmSync(missingFixture.statePath, { recursive: true });
		const loaded = readLocalHostConfig(missingFixture.configPath);
		expect(loaded.config.sourcePath).toBe(missingFixture.sourcePath);
		expect(loaded.config.statePath).toBe(missingFixture.statePath);
		expect(existsSync(missingFixture.sourcePath)).toBe(false);
		expect(existsSync(missingFixture.statePath)).toBe(false);
		const missingParent = join(missingFixture.root, "missing", "parent");
		rewriteConfig(missingFixture, {
			sourcePath: join(missingParent, "source"),
			statePath: join(missingParent, "state"),
		});
		expect(readLocalHostConfig(missingFixture.configPath).config.sourcePath).toBe(join(missingParent, "source"));
		expect(existsSync(join(missingFixture.root, "missing"))).toBe(false);
	});

	it.each([
		{ label: "oversize bytes", value: Buffer.alloc(1_000_001, 0x20), code: "input_too_large" },
		{ label: "invalid UTF-8", value: Buffer.from([0xc3, 0x28]), code: "invalid_utf8" },
		{ label: "UTF-8 BOM", value: Buffer.from("\uFEFF{}"), code: "invalid_json" },
		{ label: "invalid JSON", value: Buffer.from("{"), code: "invalid_json" },
	] as const)("reports $label distinctly", ({ value, code }) => {
		const fixture = makeFixture();
		writeFileSync(fixture.configPath, value);
		expectInputError(() => readLocalHostConfig(fixture.configPath), code);
	});

	it("maps missing input and effective-owner mismatch to content-free errors", () => {
		const fixture = makeFixture();
		expectInputError(() => readLocalHostConfig(join(fixture.root, "missing.json")), "unsafe_input");

		const euid = process.geteuid?.();
		if (euid === undefined) throw new Error("Expected a supported POSIX test host");
		vi.spyOn(process, "geteuid").mockReturnValue(euid === 0 ? 1 : euid + 1);
		expectInputError(() => readLocalHostArtifactDigest(fixture.artifactPath), "unsafe_input");
	});

	it("fails closed for an invalid effective owner", () => {
		const fixture = makeFixture();
		vi.spyOn(process, "geteuid").mockReturnValue(-1);
		expectInputError(() => readLocalHostConfig(fixture.configPath), "platform_unsupported");
	});

	it("rejects an unsupported platform and a missing effective-owner getter before filesystem access", () => {
		const fixture = makeFixture();
		const missingPath = join(fixture.root, "missing.json");
		const restorePlatform = replaceProcessProperty("platform", "win32");
		try {
			expectInputError(() => readLocalHostConfig(missingPath), "platform_unsupported");
		} finally {
			restorePlatform();
		}

		const restoreGeteuid = replaceProcessProperty("geteuid", undefined);
		try {
			expectInputError(() => readLocalHostConfig(missingPath), "platform_unsupported");
		} finally {
			restoreGeteuid();
		}
	});

	it("detects a real file metadata change between lstat and open", () => {
		const fixture = makeFixture();
		const realOpenSync = fs.openSync;
		let changed = false;
		let observedFlags = 0;
		fs.openSync = ((path, flags, mode) => {
			const descriptor = realOpenSync(path, flags, mode);
			if (!changed && path === fixture.configPath) {
				observedFlags = typeof flags === "number" ? flags : 0;
				changed = true;
				chmodSync(fixture.configPath, 0o400);
			}
			return descriptor;
		}) as typeof fs.openSync;
		syncBuiltinESMExports();
		try {
			expectInputError(() => readLocalHostConfig(fixture.configPath), "unsafe_input");
			expect(changed).toBe(true);
			expect(observedFlags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
			expect(observedFlags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
		} finally {
			fs.openSync = realOpenSync;
			syncBuiltinESMExports();
		}
	});

	it("detects same-byte leaf replacement after reading", () => {
		const fixture = makeFixture();
		const bytes = readFileSync(fixture.configPath);
		const fault = installReadFault(() => {
			renameSync(fixture.configPath, join(fixture.root, "displaced-config.json"));
			writeFileSync(fixture.configPath, bytes, { mode: 0o600 });
		});
		try {
			expectInputError(() => readLocalHostConfig(fixture.configPath), "unsafe_input");
			expect(fault.wasTriggered()).toBe(true);
		} finally {
			fault.restore();
		}
	});

	it("detects parent directory replacement after reading", () => {
		const fixture = makeFixture();
		const parent = join(fixture.root, "protected");
		const displaced = join(fixture.root, "displaced-parent");
		mkdirSync(parent, { mode: 0o700 });
		const configPath = join(parent, "config.json");
		writeFileSync(configPath, `${JSON.stringify(configValue(fixture.root))}\n`, { mode: 0o600 });
		const fault = installReadFault(() => {
			renameSync(parent, displaced);
			mkdirSync(parent, { mode: 0o700 });
		});
		try {
			expectInputError(() => readLocalHostConfig(configPath), "unsafe_input");
			expect(fault.wasTriggered()).toBe(true);
		} finally {
			fault.restore();
		}
	});

	it("bounds the read and rejects a file that grows during it", () => {
		const fixture = makeFixture();
		const fault = installReadFault(() => appendFileSync(fixture.configPath, " "));
		try {
			expectInputError(() => readLocalHostConfig(fixture.configPath), "unsafe_input");
			expect(fault.wasTriggered()).toBe(true);
		} finally {
			fault.restore();
		}
	});

	it("rejects a parent permission change even when the file stays identical", () => {
		const fixture = makeFixture();
		const fault = installReadFault(() => chmodSync(fixture.root, 0o770));
		try {
			expectInputError(() => readLocalHostConfig(fixture.configPath), "unsafe_input");
			expect(fault.wasTriggered()).toBe(true);
		} finally {
			fault.restore();
		}
	});

	it("validates receipt leaf safety for a fully bound envelope", async () => {
		const fixture = makeFixture();
		const loaded = readLocalHostConfig(fixture.configPath);
		const envelope = await exportLocalHostPlan({
			nowMillis: Date.parse("2026-09-05T12:00:00.000Z"),
			hostExecutable: fixture.artifactPath,
			configPath: loaded.path,
			futureActivationReceiptPath: join(fixture.root, "future-activation.json"),
			workingDirectory: fixture.root,
		});
		const receiptPath = join(fixture.root, "receipt.json");
		writeFileSync(receiptPath, formatPlanEnvelope(envelope), { mode: 0o600 });
		expect(readAndVerifyPlanEnvelope(receiptPath).receiptSha256).toBe(envelope.receiptSha256);

		chmodSync(receiptPath, 0o644);
		expectInputError(() => readAndVerifyPlanEnvelope(receiptPath), "unsafe_input");
		chmodSync(receiptPath, 0o600);
		linkSync(receiptPath, join(fixture.root, "receipt-link.json"));
		expectInputError(() => readAndVerifyPlanEnvelope(receiptPath), "unsafe_input");
	});

	it("revalidates programmatic read-only bindings before inspection", async () => {
		const fixture = makeFixture();
		const loaded = readLocalHostConfig(fixture.configPath);
		chmodSync(fixture.sourcePath, 0o775);
		await expect(readLocalHostStatus({ config: loaded.config, nowMillis: 0 })).rejects.toMatchObject({
			code: "unsafe_input",
			message: "Local-host input validation failed",
		});
	});
});
