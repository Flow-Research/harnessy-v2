import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const executorSource = (path: string): string =>
	fileURLToPath(new URL(`../../executor/${path}`, import.meta.url));

export default defineConfig({
	resolve: {
		// /executor has its own node_modules (bun-installed, effect
		// beta.59) for running the local web app self-contained. Test code must
		// never split runtimes: force the whole module graph onto the root
		// copies so vendored source composes with harnessy's effect instance.
		dedupe: ["effect", "@effect/platform-node", "@effect/vitest"],
		alias: [
			{
				find: /^@executor-js\/fumadb$/,
				replacement: executorSource("packages/core/fumadb/src/index.ts"),
			},
			{
				find: /^@executor-js\/fumadb\/adapters\/drizzle$/,
				replacement: executorSource("packages/core/fumadb/src/adapters/drizzle/index.ts"),
			},
			{
				find: /^@executor-js\/fumadb\/adapters\/memory$/,
				replacement: executorSource("packages/core/fumadb/src/adapters/memory/index.ts"),
			},
			{
				find: /^@executor-js\/fumadb\/query$/,
				replacement: executorSource("packages/core/fumadb/src/query/index.ts"),
			},
			{
				find: /^@executor-js\/fumadb\/schema$/,
				replacement: executorSource("packages/core/fumadb/src/schema/index.ts"),
			},
			{
				find: /^@executor-js\/integrations-registry$/,
				replacement: executorSource("packages/core/integrations-registry/src/index.ts"),
			},
			{
				find: /^@executor-js\/plugin-mcp$/,
				replacement: executorSource("packages/plugins/mcp/src/sdk/index.ts"),
			},
			{
				find: /^@executor-js\/plugin-openapi$/,
				replacement: executorSource("packages/plugins/openapi/src/sdk/index.ts"),
			},
			{
				find: /^@executor-js\/sdk$/,
				replacement: executorSource("packages/core/sdk/src/index.ts"),
			},
			{
				find: /^@executor-js\/sdk\/core$/,
				replacement: executorSource("packages/core/sdk/src/index.ts"),
			},
			{
				find: /^@executor-js\/sdk\/http-auth$/,
				replacement: executorSource("packages/core/sdk/src/http-auth/index.ts"),
			},
			{
				find: /^@executor-js\/sdk\/shared$/,
				replacement: executorSource("packages/core/sdk/src/shared.ts"),
			},
		],
	},
	test: {
		// Fixture auth.json files stay plaintext and never touch the owner's OS keychain.
		env: { PI_AUTH_ENCRYPTION: "off", HSY_AUTH_ENCRYPTION: "off" },
		// Heavy `it.live` tests (e.g. materializing the full v1 source surface) run
		// well past vitest's 5s default under full-suite load; give them headroom so
		// they don't flake on slow/cold runs.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text"],
			reportsDirectory: "coverage",
			thresholds: {
				statements: 62,
				branches: 48,
				functions: 60,
				lines: 64,
				// H-06 meeting-context contract and read-only inventory.
				"src/meeting-context*.ts": { statements: 99, branches: 99, functions: 100, lines: 99 },
				// H-10 portal read model: bounded read-only readers and their schemas.
				// One entry per file: a glob threshold is an aggregate, so a weak file could hide behind strong ones.
				"src/read-model/api-schemas.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				// One Harnessy app (Phase A): app schemas, schedules and derived tasks.
				"src/read-model/app-schemas.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/read-model/job-schedules.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/read-model/followups.ts": { statements: 95, branches: 90, functions: 100, lines: 95 },
				"src/read-model/community.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/read-model/fathom.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/read-model/files.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/read-model/life.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/read-model/meeting-config.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/read-model/meetings.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/read-model/schemas.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/read-model/service-health.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/read-model/skills.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/read-model/sqlite-snapshot.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/read-model/tile.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				"src/read-model/workspace.ts": { statements: 95, branches: 95, functions: 100, lines: 95 },
				// H-10 `harnessy portal` forwarder (the uncovered function is the host-missing catch mapper).
				"src/cli/portal.ts": { statements: 95, branches: 95, functions: 90, lines: 95 },
				// One-writer guard probe classification and bounded inconclusive retry.
				"src/jarvis/writer-check.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
				// Lease and wall-clock currency classification shared by the meeting and community owners.
				"src/jarvis/lease-clock.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
				// Meeting owner lease, clock, writer-check pause and grant validation: CI's measured
				// coverage at b6b50c75 (86.88/82.83/88.29/90.65), rounded down.
				"src/jarvis/meeting-publication/operational-runtime.ts": {
					statements: 86,
					branches: 82,
					functions: 88,
					lines: 90,
				},
				// Weekly community generation inside the review service, and its LaunchAgent plan.
				"src/jarvis/community-briefing/weekly-generation.ts": {
					statements: 95,
					branches: 95,
					// The uncovered function is the fsync-failure mapper in the atomic record write.
					functions: 95,
					lines: 95,
				},
				"src/jarvis/community-briefing/schedule.ts": { statements: 98, branches: 80, functions: 100, lines: 98 },
				// `harnessy attest`: TEST certificate signing, verification and the TEST key.
				"src/attest/eas.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
				"src/attest/certificate.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
				"src/attest/run.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
				"src/cli/attest.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
				// Built-in notifications and the `harnessy work` messages; one entry per file.
				"src/notifications/config.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
				"src/notifications/desktop.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
				"src/notifications/notifier.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
				"src/notifications/remote.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
				"src/notifications/sanitize.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
				"src/work/notifications.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
			},
		},
	},
});
