import type { CommunityBriefingProviderScope } from "@harnessy/core";

/** Synthetic scope only; never production credential or state discovery. */
export const communityFixtureScope: CommunityBriefingProviderScope = {
	tenantId: "fixture-tenant",
	subjectId: "fixture-owner",
	credentialDirectory: "/fixture/credentials",
	engineStatePath: "/fixture/executor/data.db",
	google: {
		owner: "org",
		connection: "briefingsGoogle",
		authTemplate: "google-drive-file-test-token",
		ownerEmail: "owner@example.test",
		folderPath: "Published/Briefings",
	},
	discord: { owner: "org", connection: "briefing", authTemplate: "discord-bot", channelId: "555555555555555555" },
	transport: {
		mode: "loopback",
		googleDriveBaseUrl: "http://127.0.0.1:1",
		googleDocsBaseUrl: "http://127.0.0.1:1",
		discordBaseUrl: "http://127.0.0.1:1",
	},
};
