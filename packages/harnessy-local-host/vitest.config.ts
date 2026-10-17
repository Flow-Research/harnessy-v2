import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const coreSource = fileURLToPath(new URL("../harnessy-core/src/meeting-publication-inspector.ts", import.meta.url));

export default defineConfig({
	resolve: {
		dedupe: ["effect", "@effect/vitest"],
		alias: [
			{ find: /^@harnessy\/core\/community-briefing$/, replacement: fileURLToPath(new URL("../harnessy-core/src/community-briefing.ts", import.meta.url)) },
			{ find: /^@harnessy\/core\/wiki$/, replacement: fileURLToPath(new URL("../harnessy-core/src/wiki.ts", import.meta.url)) },
			{
				find: /^@harnessy\/core\/meeting-publication$/,
				replacement: fileURLToPath(new URL("../harnessy-core/src/meeting-publication.ts", import.meta.url)),
			},
			{
				find: /^@harnessy\/core\/read-model$/,
				replacement: fileURLToPath(new URL("../harnessy-core/src/read-model.ts", import.meta.url)),
			},
			{
				find: /^@harnessy\/core\/meeting-publication-inspector$/,
				replacement: coreSource,
			},
		],
	},
	test: {
		// Fixture auth.json files stay plaintext and never touch the owner's OS keychain.
		env: { PI_AUTH_ENCRYPTION: "off" },
		testTimeout: 30_000,
		hookTimeout: 30_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/cli.ts", "src/**/*-cli.ts", "src/**/*.d.ts"],
			reporter: ["text"],
			reportsDirectory: "coverage",
			thresholds: {
				statements: 80,
				branches: 75,
				functions: 80,
				lines: 80,
				// H-10 portal API: loopback server, sessions, sources and connection status.
				// One entry per file: a glob threshold is an aggregate, so a weak file could hide behind strong ones.
				"src/portal/auth.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/command.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/connections.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/launchd-plan.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/learning.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/openapi.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				// H-10 portal page: static files, view model, DOM mount and page script.
				"src/portal/page-assets.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/page/app.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/page/mount.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/page/view-model.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/routes.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/server.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/sources.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/token-store.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
			},
		},
	},
});
