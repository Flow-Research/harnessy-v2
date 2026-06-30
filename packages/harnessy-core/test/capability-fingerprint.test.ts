import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";

import { CapabilityFingerprinter } from "../src/capabilities/fingerprint.ts";

/** Provide the live fingerprinter plus Node platform services for filesystem-backed tests. */
const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(CapabilityFingerprinter.layer), Effect.provide(NodeServices.layer));

describe("CapabilityFingerprinter", () => {
	it.effect("produces stable file fingerprints and changes when content changes", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const filePath = yield* fs.makeTempFileScoped();
				yield* fs.writeFileString(filePath, "alpha\n");

				const fingerprinter = yield* CapabilityFingerprinter;
				const first = yield* fingerprinter.fingerprintPath(filePath);
				const second = yield* fingerprinter.fingerprintPath(filePath);
				expect(first.kind).toBe("file");
				expect(first.sha256).toBe(second.sha256);
				expect(first.bytes).toBe(6);
				expect(first.files).toEqual([]);

				yield* fs.writeFileString(filePath, "alpha changed\n");
				const changed = yield* fingerprinter.fingerprintPath(filePath);
				expect(changed.sha256).not.toBe(first.sha256);
			}),
		),
	);

	it.effect("hashes directory entries deterministically with executable metadata", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const root = yield* fs.makeTempDirectoryScoped();
				yield* fs.makeDirectory(`${root}/b`, { recursive: true });
				yield* fs.makeDirectory(`${root}/a`, { recursive: true });
				yield* fs.writeFileString(`${root}/b/two.txt`, "two");
				yield* fs.writeFileString(`${root}/a/one.sh`, "one");
				yield* fs.chmod(`${root}/a/one.sh`, 0o755);

				const fingerprinter = yield* CapabilityFingerprinter;
				const first = yield* fingerprinter.fingerprintPath(root);
				const second = yield* fingerprinter.fingerprintPath(root);

				expect(first.kind).toBe("directory");
				expect(first.sha256).toBe(second.sha256);
				expect(first.bytes).toBe(6);
				expect(first.files.map((file) => [file.path, file.bytes, file.executable])).toEqual([
					["a/one.sh", 3, true],
					["b/two.txt", 3, false],
				]);
				expect(first.issues).toEqual([]);
			}),
		),
	);

	it.effect("changes directory digest when nested content changes", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const root = yield* fs.makeTempDirectoryScoped();
				yield* fs.writeFileString(`${root}/content.md`, "before");

				const fingerprinter = yield* CapabilityFingerprinter;
				const before = yield* fingerprinter.fingerprintPath(root);
				yield* fs.writeFileString(`${root}/content.md`, "after");
				const after = yield* fingerprinter.fingerprintPath(root);

				expect(after.sha256).not.toBe(before.sha256);
			}),
		),
	);
});
