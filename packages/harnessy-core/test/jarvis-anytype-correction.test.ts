import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { correctJarvisAnytypeSource } from "../src/runtime/jarvis-anytype-correction.ts";

describe("V2 AnyType installation correction", () => {
	const source = readFileSync(
		new URL("../../capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/anytype_client.py", import.meta.url),
		"utf8",
	);
	it("checks both collection and page attachment outcomes", () => {
		const corrected = correctJarvisAnytypeSource(source);
		expect(corrected.split("if not self._add_to_collection(space_id, parent_id, created.id):")).toHaveLength(3);
		expect(corrected.split("reconcile before retrying")).toHaveLength(3);
	});
	it("refuses unknown or previously corrected input", () => {
		expect(() => correctJarvisAnytypeSource(`${source}\n`)).toThrow("Unknown Jarvis AnyType source");
		expect(() => correctJarvisAnytypeSource(correctJarvisAnytypeSource(source))).toThrow(
			"Unknown Jarvis AnyType source",
		);
	});
});
