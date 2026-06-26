import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Heavy `it.live` tests (e.g. materializing the full v1 source surface) run
		// well past vitest's 5s default under full-suite load; give them headroom so
		// they don't flake on slow/cold runs.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
