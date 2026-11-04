import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import {
	MeetingPublicationWriteAuthority,
	MeetingPublicationWriteAuthorityState,
	MeetingPublicationWriteBinding,
} from "../src/jarvis/meeting-publication/authority.ts";
import { issueMeetingPublicationWriteGrantForTest } from "../src/jarvis/meeting-publication/authority-grant-registry.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";

const roots: Array<string> = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const markdown = (summary: string) => `# Weekly Sync

## Metadata
- Project: alpha
- Date: 2026-09-03
- Fingerprint: weekly-sync

## Executive Summary
${summary}

## Meeting Purpose
Preserve the exact source revision.
`;

const setup = async () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-meeting-source-authority-"));
	roots.push(root);
	const sourcePath = join(root, "notes");
	mkdirSync(sourcePath);
	const path = join(sourcePath, "meeting.md");
	const original = markdown("Original summary.");
	writeFileSync(path, original);
	const config = new JarvisMeetingPublicationConfig({
		enabled: true,
		project: "alpha",
		sourcePath,
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
		discordChannelId: "123456789012345678",
	});
	const current = await Effect.runPromise(
		Effect.gen(function* () {
			return yield* (yield* MeetingPublicationSource).read(path);
		}).pipe(
			Effect.provide(
				MeetingPublicationSource.layer(config).pipe(Layer.provide(MeetingPublicationWriteAuthority.defaultLayer)),
			),
		),
	);
	return { config, current, original, path };
};

const exactGrantLayer = (
	config: JarvisMeetingPublicationConfig,
	expected: { readonly itemId: string; readonly sourceHash: string },
	calls: Array<MeetingPublicationWriteBinding>,
) => {
	const fixedBinding = Object.freeze(
		new MeetingPublicationWriteBinding({
			sourcePath: resolve(config.sourcePath ?? ""),
			statePath: resolve(config.statePath ?? ""),
			item: Object.freeze({ ...expected }),
		}),
	);
	return Layer.succeed(
		MeetingPublicationWriteAuthority,
		MeetingPublicationWriteAuthority.of({
			authorize: (operation, binding) => {
				calls.push(binding);
				return Effect.succeed(
					issueMeetingPublicationWriteGrantForTest(operation, fixedBinding, {
						validate: (issuedOperation, issuedBinding) =>
							Effect.succeed(
								issuedOperation === "source_update" &&
									issuedBinding.sourcePath === fixedBinding.sourcePath &&
									issuedBinding.statePath === fixedBinding.statePath &&
									issuedBinding.item?.itemId === expected.itemId &&
									issuedBinding.item.sourceHash === expected.sourceHash,
							),
					}),
				);
			},
			state: () =>
				Effect.succeed(
					new MeetingPublicationWriteAuthorityState({
						owner: "v2_test",
						authorized: true,
						code: "authorized",
					}),
				),
		}),
	);
};

const update = (
	fixture: Awaited<ReturnType<typeof setup>>,
	requests: { readonly itemId: string; readonly sourceHash: string },
	calls: Array<MeetingPublicationWriteBinding>,
) =>
	Effect.gen(function* () {
		return yield* (yield* MeetingPublicationSource).update({
			path: fixture.path,
			markdown: markdown("Authorized summary."),
			expectedItemId: requests.itemId,
			expectedSourceHash: requests.sourceHash,
		});
	}).pipe(
		Effect.provide(
			MeetingPublicationSource.layer(fixture.config).pipe(
				Layer.provide(exactGrantLayer(fixture.config, fixture.current, calls)),
			),
		),
	);

describe("MeetingPublicationSource exact authority", () => {
	it("binds source_update authorization to the exact requested item revision", async () => {
		const fixture = await setup();
		const calls: Array<MeetingPublicationWriteBinding> = [];
		const updated = await Effect.runPromise(update(fixture, fixture.current, calls));

		expect(calls).toHaveLength(1);
		expect(calls[0]?.item).toEqual({
			itemId: fixture.current.itemId,
			sourceHash: fixture.current.sourceHash,
		});
		expect(updated.itemId).toBe(fixture.current.itemId);
		expect(updated.sourceHash).not.toBe(fixture.current.sourceHash);
		expect(updated.sourceHash).toBe(createHash("sha256").update(readFileSync(fixture.path)).digest("hex"));
		expect(readFileSync(fixture.path, "utf8")).toBe(markdown("Authorized summary."));
		expect(updated.markdown).toBe(markdown("Authorized summary."));
	});

	it("rejects an authentic source_update grant retargeted to another item or source hash before mutation", async () => {
		for (const requested of [
			{ itemId: "f".repeat(24), sourceHash: "same" },
			{ itemId: "same", sourceHash: "f".repeat(64) },
		] as const) {
			const fixture = await setup();
			const calls: Array<MeetingPublicationWriteBinding> = [];
			const itemId = requested.itemId === "same" ? fixture.current.itemId : requested.itemId;
			const sourceHash = requested.sourceHash === "same" ? fixture.current.sourceHash : requested.sourceHash;
			const result = await Effect.runPromise(Effect.result(update(fixture, { itemId, sourceHash }, calls)));

			expect(result).toMatchObject({
				_tag: "Failure",
				failure: { operation: "source_update", code: "binding_mismatch" },
			});
			expect(calls[0]?.item).toEqual({ itemId, sourceHash });
			expect(readFileSync(fixture.path, "utf8")).toBe(fixture.original);
			expect(readdirSync(fixture.config.sourcePath ?? "")).toEqual(["meeting.md"]);
		}
	});
});
