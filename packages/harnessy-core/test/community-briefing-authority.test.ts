import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { validateCommunityBriefingWriteGrant } from "../src/community-briefing.ts";
import { issueCommunityBriefingWriteGrantForTest } from "../src/jarvis/community-briefing/authority.ts";

const binding = {
	queuePath: "/tmp/community.sqlite3",
	statePath: "/tmp/community-state",
	providerScope: {
		tenantId: "tenant",
		subjectId: "reviewer",
		credentialDirectory: "/fixture/credentials",
		engineStatePath: "/fixture/data.db",
		google: {
			owner: "org",
			connection: "briefingGoogle",
			authTemplate: "google-drive-file",
			ownerEmail: "owner@example.test",
			folderPath: "Briefings",
		},
		discord: {
			owner: "org",
			connection: "briefingDiscord",
			authTemplate: "discord-bot",
			channelId: "555555555555555555",
		},
		transport: { mode: "production" },
	},
	item: { briefingId: "briefing-1", sourceHash: "a".repeat(64) },
} as const;

describe("community briefing authority", () => {
	it("accepts only the community-scoped publish grant and exact revision", async () => {
		const grant = issueCommunityBriefingWriteGrantForTest("publish", binding);
		await expect(
			Effect.runPromise(validateCommunityBriefingWriteGrant(grant, "publish", binding.item)),
		).resolves.toBe(grant);
		await expect(
			Effect.runPromise(
				validateCommunityBriefingWriteGrant(grant, "publish", {
					...binding.item,
					sourceHash: "b".repeat(64),
				}),
			),
		).rejects.toThrow("invalid community briefing grant");
	});

	it("rechecks revocation before provider use", async () => {
		const grant = issueCommunityBriefingWriteGrantForTest("publish", binding, {
			validate: () => Effect.succeed(false),
		});
		await expect(
			Effect.runPromise(validateCommunityBriefingWriteGrant(grant, "publish", binding.item)),
		).rejects.toThrow("revoked community briefing grant");
	});
});
