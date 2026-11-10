import { createHash } from "node:crypto";
import { PerformanceEntry } from "node:perf_hooks";

const crypto: Crypto = globalThis.crypto;
const console: Console = globalThis.console;
const performanceConstructor: typeof globalThis.PerformanceEntry = PerformanceEntry;
const bytes: Uint8Array = Buffer.from("host type control");
const digest: string = createHash("sha256").update(bytes).digest("hex");
const browserInput: FileList = { length: 0, item: () => null };

// @ts-expect-error Workers does not provide a DOM FileList constructor.
new FileList();
// @ts-expect-error The qualified Worker runtime does not expose BroadcastChannel.
new BroadcastChannel("unsupported");
// @ts-expect-error Browser credential modes remain a closed union.
const credentials: RequestCredentials = "unrestricted";
// @ts-expect-error Crypto input still requires a valid buffer source.
crypto.subtle.digest("SHA-256", { wrong: true });
// @ts-expect-error Host declarations must not add a browser document.
document.createElement("div");

void [console, performanceConstructor, digest, browserInput, credentials];
