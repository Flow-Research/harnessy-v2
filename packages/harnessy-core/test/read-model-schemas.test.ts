import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import * as core from "../src/index.ts";
import { PORTAL_SCHEMA_VERSION, PortalSchemas, TileSchema } from "../src/read-model/schemas.ts";
import {
	DEFAULT_READ_TIMEOUT_MS,
	guardTile,
	ReadModelStateError,
	readTimeout,
	stateTile,
} from "../src/read-model/tile.ts";

const NOW = new Date("2026-10-17T12:00:00.000Z");

describe("portal schemas", () => {
	it("are plain JSON Schema with a version", () => {
		const encoded = JSON.parse(JSON.stringify(PortalSchemas)) as Record<string, unknown>;
		expect(encoded.version).toBe(PORTAL_SCHEMA_VERSION);
		for (const [name, schema] of Object.entries(PortalSchemas)) {
			if (name === "version") continue;
			expect(typeof schema, name).toBe("object");
			expect(JSON.stringify(schema), name).toMatch(/"(type|anyOf)"/u);
		}
	});

	it("reject tiles with unknown states, extra fields or data of the wrong shape", () => {
		const tile = TileSchema(PortalSchemas.SkillsSummary);
		expect(Value.Check(tile, { state: "ok", readAt: NOW.toISOString(), data: { count: 1, truncated: false } })).toBe(
			true,
		);
		expect(Value.Check(tile, { state: "fine", readAt: NOW.toISOString() })).toBe(false);
		expect(Value.Check(tile, { state: "ok", readAt: NOW.toISOString(), detail: "x" })).toBe(false);
		expect(Value.Check(tile, { state: "ok", readAt: NOW.toISOString(), data: { count: -1, truncated: false } })).toBe(
			false,
		);
		expect(Value.Check(PortalSchemas.MeetingProviderHealth, { providers: [{ provider: "slack" }] })).toBe(false);
	});

	it("are exported from the package root with the readers", () => {
		for (const name of [
			"PortalSchemas",
			"readLifeSummary",
			"readLifeBrief",
			"readFathomSummary",
			"readCommunitySummary",
			"readMeetingSummary",
			"readWorkspaceSummary",
			"readSkillsSummary",
			"readServiceHealth",
			"readSqliteSnapshot",
			"inspectMeetingPublicationQueue",
			"inspectCommunityBriefingStatus",
			"listCommunityBriefings",
			"inspectFathomStatus",
		])
			expect(core, name).toHaveProperty(name);
	});
});

describe("tile helpers", () => {
	it("bound the timeout and turn thrown errors into fixed reasons", () => {
		expect(readTimeout({})).toBe(DEFAULT_READ_TIMEOUT_MS);
		expect(readTimeout({ timeoutMs: 50 })).toBe(50);
		expect(readTimeout({ timeoutMs: 60_000 })).toBe(10_000);
		expect(readTimeout({ timeoutMs: -1 })).toBe(DEFAULT_READ_TIMEOUT_MS);
		expect(readTimeout({ timeoutMs: Number.NaN })).toBe(DEFAULT_READ_TIMEOUT_MS);
		expect(
			guardTile(NOW, () => {
				throw new Error("/Users/owner/private path in a message");
			}),
		).toEqual(stateTile("error", "read_failed", NOW));
		expect(
			guardTile(NOW, () => {
				throw new ReadModelStateError("busy", "database_busy");
			}),
		).toEqual({ state: "busy", reason: "database_busy", readAt: NOW.toISOString() });
	});
});
