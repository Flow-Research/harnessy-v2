import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const coreSource = fileURLToPath(new URL("../harnessy-core/src/meeting-publication-inspector.ts", import.meta.url));

export default defineConfig({
	// The app's tests render React components (`test/app/*.test.tsx`, jsdom per file).
	oxc: { jsx: { runtime: "automatic", importSource: "react" } },
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
		env: { PI_AUTH_ENCRYPTION: "off", HSY_AUTH_ENCRYPTION: "off" },
		projects: [
			{ extends: true, test: { name: "node", include: ["test/**/*.test.ts"], exclude: ["test/app/**"] } },
			{
				// The app's tests run in jsdom, with Node module resolution so they can start a real portal.
				extends: true,
				test: {
					name: "app",
					include: ["test/app/**/*.test.ts", "test/app/**/*.test.tsx"],
					environment: "./test/support/jsdom-ssr-environment.ts",
				},
			},
		],
		testTimeout: 30_000,
		hookTimeout: 30_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts", "src/**/*.tsx"],
			exclude: [
				"src/cli.ts",
				"src/**/*-cli.ts",
				"src/**/*.d.ts",
				// Build configuration and the browser entry point; the browser smoke covers the entry.
				"src/portal/app/vite.config.ts",
				"src/portal/app/main.tsx",
				// Types only.
				"src/portal/app/lib/api-types.ts",
			],
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
				// H-10 one app (Phase A): manifest-pinned assets, read routes, inbox, jobs and liveness.
				"src/portal/page-assets.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/inbox.ts": { statements: 95, branches: 90, functions: 100, lines: 95 },
				"src/portal/jobs.ts": { statements: 95, branches: 90, functions: 100, lines: 95 },
				"src/portal/liveness.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/task-changes.ts": { statements: 95, branches: 90, functions: 100, lines: 95 },
				// The app's browser code: pure libraries at the portal floor, React screens at 80.
				"src/portal/app/lib/safe-href.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/app/lib/session.ts": { statements: 95, branches: 90, functions: 100, lines: 95 },
				"src/portal/app/lib/markdown.ts": { statements: 95, branches: 90, functions: 100, lines: 95 },
				"src/portal/app/lib/router.ts": { statements: 90, branches: 90, functions: 90, lines: 90 },
				"src/portal/app/lib/data.tsx": { statements: 90, branches: 85, functions: 90, lines: 90 },
				"src/portal/app/lib/format.ts": { statements: 90, branches: 85, functions: 90, lines: 90 },
				"src/portal/app/lib/browser.ts": { statements: 85, branches: 80, functions: 100, lines: 90 },
				"src/portal/app/lib/keys.tsx": { statements: 90, branches: 75, functions: 100, lines: 90 },
				"src/portal/app/**/*.tsx": { statements: 80, branches: 70, functions: 75, lines: 80 },
				"src/portal/process.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/routes.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/server.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/sources.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/portal/token-store.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
			},
		},
	},
});
