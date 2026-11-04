import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import * as HarnessyEngine from "../dist/index";

describe("@harnessy/engine exports", () => {
	it("publishes exactly the root and Cloudflare entries", async () => {
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			readonly exports: Record<string, unknown>;
		};
		expect(Object.keys(manifest.exports)).toEqual([".", "./cloudflare"]);
	});

	it("uses one bundled Effect context for the facade and vendored host tags", () => {
		expect(HarnessyEngine.Context.isKey(HarnessyEngine.DbProvider)).toBe(true);
		expect(HarnessyEngine.Context.isKey(HarnessyEngine.IdentityProvider)).toBe(true);
		expect(HarnessyEngine.Effect.isEffect(HarnessyEngine.DbProvider)).toBe(true);
		expect(HarnessyEngine.matchPattern("github.*", "github.issues.create")).toBe(true);
	});
});
