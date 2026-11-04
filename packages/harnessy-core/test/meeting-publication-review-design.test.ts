import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Review is server-rendered under a hashed CSP and cannot import the React app.
// Keep its small palette contract aligned without a runtime package dependency.
const review = readFileSync(new URL("../src/jarvis/meeting-publication/review.ts", import.meta.url), "utf8");
const portal = readFileSync(
	new URL("../../harnessy-local-host/src/portal/app/styles/tokens.css", import.meta.url),
	"utf8",
);

describe("meeting review design contract", () => {
	it("uses the portal palette in both system themes", () => {
		for (const [reviewName, portalName] of [
			["canvas", "bg"],
			["surface", "panel"],
			["raised", "raised"],
			["ink", "text"],
			["muted", "text-2"],
			["line", "hairline"],
			["accent", "ok-text"],
			["danger", "danger-text"],
			["on-accent", "on-accent"],
		]) {
			const values = (source: string, name: string | undefined) =>
				[...source.matchAll(new RegExp(`--${name}:\\s*(#[a-f0-9]+)`, "g"))].slice(0, 2).map((match) => match[1]);
			expect(values(review, reviewName), reviewName).toEqual(values(portal, portalName));
		}
	});
});
