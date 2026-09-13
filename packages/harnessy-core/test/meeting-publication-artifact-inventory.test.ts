import { createHash } from "node:crypto";
import type * as Fs from "node:fs";
import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as eventLoopTurn } from "node:timers/promises";
import type * as Url from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	assertMeetingPublicationArtifactInventoryCurrentAsync,
	assertMeetingPublicationSmokeArtifactInventoryCurrent,
	MeetingPublicationSmokeRuntimeError,
	type MeetingPublicationSmokeRuntimeObservation,
	type VerifiedMeetingPublicationRuntimeInput,
} from "../src/jarvis/meeting-publication/operational-input.ts";

const instrumentation = vi.hoisted(() => ({
	coreAnchor: "",
	lstats: new Map<string, number>(),
	reads: 0,
	onRead: undefined as (() => void) | undefined,
}));

// Only map this module's self-anchor into the synthetic inventory. The installed
// gate separately proves the real import anchor. No filesystem result is faked:
// wrappers count actual calls and inject real, deterministic temporary mutations.
vi.mock("node:url", async (importOriginal) => {
	const actual = await importOriginal<typeof Url>();
	return {
		...actual,
		fileURLToPath: (value: string | URL) =>
			String(value).endsWith("/meeting-publication/operational-input.ts") && instrumentation.coreAnchor !== ""
				? instrumentation.coreAnchor
				: actual.fileURLToPath(value),
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		lstatSync: ((...args: Array<unknown>) => {
			const path = String(args[0]);
			instrumentation.lstats.set(path, (instrumentation.lstats.get(path) ?? 0) + 1);
			return Reflect.apply(actual.lstatSync, actual, args);
		}) as typeof actual.lstatSync,
		readSync: ((...args: Array<unknown>) => {
			instrumentation.reads += 1;
			instrumentation.onRead?.();
			return Reflect.apply(actual.readSync, actual, args);
		}) as typeof actual.readSync,
	};
});

const roots: Array<string> = [];
afterEach(() => {
	instrumentation.onRead = undefined;
	instrumentation.coreAnchor = "";
	instrumentation.lstats.clear();
	instrumentation.reads = 0;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (count = 8) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "meeting-artifact-inventory-"));
	roots.push(root);
	const shared = join(root, "runtime", "shared", "nested");
	mkdirSync(shared, { recursive: true, mode: 0o700 });
	const paths = Array.from({ length: count }, (_, index) => join(shared, `${String(index).padStart(5, "0")}.js`));
	for (const path of paths)
		writeFileSync(path, `export const value = ${JSON.stringify(path.split("/").at(-1))};\n`, { mode: 0o600 });
	instrumentation.coreAnchor = paths[0] as string;
	const manifest = {
		kind: "harnessy.runtime-artifact-manifest" as const,
		schemaVersion: 1 as const,
		root,
		anchors: (["core", "host", "sdk", "dependencies"] as const).map((role, index) => ({
			role,
			path: paths[index] as string,
		})),
		files: paths.map((path) => {
			const stat = lstatSync(path, { bigint: true });
			return {
				path,
				device: stat.dev.toString(),
				inode: stat.ino.toString(),
				sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
			};
		}),
	};
	// This assertion only consumes inventory/kind and UID; no authority is issued,
	// no signature is manufactured, and no other runtime API receives these values.
	const verified = {
		kind: "full_review",
		artifactManifest: manifest,
	} as unknown as VerifiedMeetingPublicationRuntimeInput;
	const observation = { uid: BigInt(process.getuid?.() ?? 0) } as MeetingPublicationSmokeRuntimeObservation;
	const check = () => assertMeetingPublicationSmokeArtifactInventoryCurrent(verified, observation);
	const checkAsync = (signal?: AbortSignal) =>
		assertMeetingPublicationArtifactInventoryCurrentAsync(verified, observation, signal);
	instrumentation.lstats.clear();
	instrumentation.reads = 0;
	return { root, shared, paths, check, checkAsync };
};

describe("meeting runtime artifact inventory", () => {
	it("rehashes every file across async calls and lets queued I/O run during a large validation", async () => {
		const value = fixture(1000);
		let completed = false;
		let queued = false;
		let observedReads = 0;
		let observedBeforeCompletion = false;
		let observation: Promise<void> | undefined;
		instrumentation.onRead = () => {
			if (queued) return;
			queued = true;
			observation = eventLoopTurn().then(() => {
				observedReads = instrumentation.reads;
				observedBeforeCompletion = !completed;
			});
		};
		await value.checkAsync();
		completed = true;
		await observation;
		expect(observedBeforeCompletion).toBe(true);
		expect(observedReads).toBeGreaterThan(0);
		expect(observedReads).toBeLessThan(value.paths.length * 2);
		const reads = instrumentation.reads;
		expect(reads).toBe(value.paths.length * 2);
		await value.checkAsync();
		expect(instrumentation.reads).toBe(reads * 2);
	});

	it("rejects an earlier hashed file changed during an async yield", async () => {
		const value = fixture(1000);
		let mutation: Promise<void> | undefined;
		let changed = false;
		instrumentation.onRead = () => {
			if (mutation !== undefined) return;
			mutation = eventLoopTurn().then(() => {
				const first = value.paths[0] as string;
				const bytes = readFileSync(first);
				bytes[0] = bytes[0] === 120 ? 121 : 120;
				writeFileSync(first, bytes);
				changed = true;
			});
		};
		await expect(value.checkAsync()).rejects.toThrow(MeetingPublicationSmokeRuntimeError);
		await mutation;
		expect(changed).toBe(true);
		expect(instrumentation.reads).toBe(value.paths.length * 2);
	});

	it("stops async filesystem work on cancellation without a background reader", async () => {
		const value = fixture(1000);
		const controller = new AbortController();
		instrumentation.onRead = () => controller.abort();
		await expect(value.checkAsync(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		const readsAtExit = instrumentation.reads;
		expect(readsAtExit).toBeGreaterThan(0);
		expect(readsAtExit).toBeLessThan(value.paths.length * 2);
		await eventLoopTurn();
		await eventLoopTurn();
		expect(instrumentation.reads).toBe(readsAtExit);
		instrumentation.onRead = undefined;
		await expect(value.checkAsync(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(instrumentation.reads).toBe(readsAtExit);
	});

	it("keeps concurrent async inventories independent when one is cancelled", async () => {
		const value = fixture(1000);
		const controller = new AbortController();
		const first = value.checkAsync(controller.signal);
		const second = value.checkAsync();
		controller.abort();
		const result = await Promise.allSettled([first, second]);
		expect(result[0].status).toBe("rejected");
		expect(result[1].status).toBe("fulfilled");
		expect(instrumentation.reads).toBe(value.paths.length * 2);
		const reads = instrumentation.reads;
		await Promise.all([value.checkAsync(), value.checkAsync()]);
		expect(instrumentation.reads).toBe(reads * 3);
	});

	it("reads every file again on every validation and detects same-size content drift", () => {
		const value = fixture();
		value.check();
		const firstReads = instrumentation.reads;
		expect(firstReads).toBeGreaterThanOrEqual(value.paths.length);
		value.check();
		expect(instrumentation.reads).toBe(firstReads * 2);
		const last = value.paths.at(-1) as string;
		const bytes = readFileSync(last);
		bytes[0] = bytes[0] === 120 ? 121 : 120;
		writeFileSync(last, bytes);
		expect(value.check).toThrow(MeetingPublicationSmokeRuntimeError);
	});

	it.each(["symlink", "permissions", "new-file", "hardlink"] as const)(
		"rejects %s after an earlier successful check",
		(variant) => {
			const value = fixture();
			value.check();
			const target = value.paths[0] as string;
			if (variant === "symlink") {
				unlinkSync(target);
				symlinkSync(value.paths[1] as string, target);
			}
			if (variant === "permissions") chmodSync(value.shared, 0o777);
			if (variant === "new-file") writeFileSync(join(value.shared, "unexpected.js"), "new", { mode: 0o600 });
			if (variant === "hardlink") {
				const outside = mkdtempSync(join(realpathSync(tmpdir()), "meeting-artifact-link-"));
				roots.push(outside);
				linkSync(target, join(outside, "linked.js"));
			}
			expect(value.check).toThrow(MeetingPublicationSmokeRuntimeError);
		},
	);

	it.each(["new-file", "permissions"] as const)(
		"rejects a directory %s mutation during file reading at the final directory pass",
		(variant) => {
			const value = fixture();
			let changed = false;
			instrumentation.onRead = () => {
				if (changed) return;
				changed = true;
				if (variant === "new-file") writeFileSync(join(value.shared, "late.js"), "late", { mode: 0o600 });
				else chmodSync(value.shared, 0o755);
			};
			expect(value.check).toThrow(MeetingPublicationSmokeRuntimeError);
			expect(changed).toBe(true);
			expect(instrumentation.reads).toBeGreaterThanOrEqual(value.paths.length * 2);
		},
	);

	it("checks shared ancestors a constant number of times independent of file count", () => {
		const value = fixture(128);
		value.check();
		for (let directory = value.shared; ; directory = dirname(directory)) {
			const count = instrumentation.lstats.get(directory) ?? 0;
			expect(count).toBeGreaterThanOrEqual(2);
			expect(count).toBeLessThanOrEqual(3);
			if (dirname(directory) === directory) break;
		}
		expect(instrumentation.reads).toBeGreaterThanOrEqual(128);
	});
});
