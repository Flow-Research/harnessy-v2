import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const coreSource = fileURLToPath(new URL("../harnessy-core/src/meeting-publication-inspector.ts", import.meta.url));

export default defineConfig({
	resolve: {
		dedupe: ["effect", "@effect/vitest"],
		alias: [
			{
				find: /^@harnessy\/core\/meeting-publication$/,
				replacement: fileURLToPath(new URL("../harnessy-core/src/meeting-publication.ts", import.meta.url)),
			},
			{
				find: /^@harnessy\/core\/meeting-publication-inspector$/,
				replacement: coreSource,
			},
		],
	},
	test: {
		testTimeout: 30_000,
		hookTimeout: 30_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/cli.ts", "src/**/*-cli.ts", "src/**/*.d.ts"],
			reporter: ["text"],
			reportsDirectory: "coverage",
			thresholds: { statements: 80, branches: 75, functions: 80, lines: 80 },
		},
	},
});
