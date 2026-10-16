import type { OpenApiPluginOptions } from "@executor-js/plugin-openapi";
import type { AuthPlacement } from "@executor-js/sdk/http-auth";

type OpenApiPreset = NonNullable<OpenApiPluginOptions["presets"]>[number];

export const HARNESSY_PRESETS: readonly OpenApiPreset[] = [
	{
		id: "discord",
		name: "Discord",
		summary: "Servers, channels, messages, members, and interactions.",
		url: "https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json",
		icon: "https://integrations.sh/logo/discord.com",
		featured: true,
		defaultSlug: "discord",
		authTemplate: [
			{
				kind: "apiKey",
				slug: "BotToken",
				name: "Bot token",
				placements: [
					{ carrier: "header", name: "Authorization", prefix: "Bot " },
				] satisfies readonly AuthPlacement[],
			},
		],
	},
	{
		id: "github",
		name: "GitHub",
		summary: "Repositories, issues, pull requests, actions, and users.",
		url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
		icon: "https://svgl.app/library/github_dark.svg",
		featured: true,
		defaultSlug: "github",
		authTemplate: [
			{
				slug: "githubOAuth2",
				kind: "oauth2",
				authorizationUrl: "https://github.com/login/oauth/authorize",
				tokenUrl: "https://github.com/login/oauth/access_token",
				scopes: ["repo", "read:user", "user:email"],
			},
			{
				kind: "apiKey",
				slug: "githubPat",
				name: "Personal access token",
				placements: [
					{ carrier: "header", name: "Authorization", prefix: "Bearer " },
				] satisfies readonly AuthPlacement[],
			},
		],
	},
	{
		id: "slack",
		name: "Slack",
		summary: "Messages, conversations, users, files, and workspace administration.",
		// Slack publishes Swagger 2.0; APIs.guru provides its OpenAPI 3 conversion,
		// which the executor parser can load.
		url: "https://api.apis.guru/v2/specs/slack.com/1.7.0/openapi.json",
		icon: "https://integrations.sh/logo/slack.com",
		featured: true,
		defaultSlug: "slack",
		authTemplate: [
			{
				kind: "apiKey",
				slug: "slackToken",
				name: "Bearer token",
				placements: [
					{ carrier: "header", name: "Authorization", prefix: "Bearer " },
				] satisfies readonly AuthPlacement[],
			},
		],
	},
	{
		id: "gmail",
		name: "Gmail",
		summary: "Messages, threads, labels, drafts, and mailbox settings.",
		url: "https://api.apis.guru/v2/specs/googleapis.com/gmail/v1/openapi.json",
		icon: "https://fonts.gstatic.com/s/i/productlogos/gmail_2020q4/v8/web-96dp/logo_gmail_2020q4_color_2x_web_96dp.png",
		featured: true,
		family: "google",
		defaultSlug: "gmail",
		authTemplate: [
			{
				slug: "Oauth2c",
				kind: "oauth2",
				authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
				tokenUrl: "https://oauth2.googleapis.com/token",
				scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"],
			},
		],
	},
	{
		id: "google-drive",
		name: "Google Drive",
		summary: "Files, folders, permissions, and shared drives.",
		url: "https://api.apis.guru/v2/specs/googleapis.com/drive/v3/openapi.json",
		icon: "https://fonts.gstatic.com/s/i/productlogos/drive_2020q4/v8/192px.svg",
		featured: true,
		family: "google",
		defaultSlug: "google-drive",
		authTemplate: [
			{
				slug: "Oauth2c",
				kind: "oauth2",
				authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
				tokenUrl: "https://oauth2.googleapis.com/token",
				scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/drive"],
			},
		],
	},
];
