import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// This is the same date and Node compatibility mode as the packaged Worker.
// Use a real isolated workerd process; no account, database or provider is used.
const expected = {
  console: "object",
  crypto: "object",
  performance: "object",
  navigator: "object",
  Buffer: "function",
  process: "object",
  global: "object",
  PerformanceEntry: "function",
  PerformanceMark: "function",
  PerformanceMeasure: "function",
  PerformanceObserver: "function",
  PerformanceObserverEntryList: "function",
  PerformanceResourceTiming: "function",
  MessageChannel: "function",
  MessagePort: "function",
  BroadcastChannel: "undefined",
  FileList: "undefined",
};
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
    script: `
    import * as perf from "node:perf_hooks";
    export default { fetch() {
      const globals = Object.fromEntries(${JSON.stringify(Object.keys(expected))}.map(name => [name, typeof globalThis[name]]));
      const constructorsMatch = ["PerformanceEntry", "PerformanceMark", "PerformanceMeasure", "PerformanceObserver", "PerformanceObserverEntryList", "PerformanceResourceTiming"]
        .every(name => globalThis[name] === perf[name]);
      return Response.json({ globals, constructorsMatch });
    } };
  `,
  }),
);
try {
  const response = await runtime.dispatchFetch("https://type-profile.test");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.globals, expected);
  assert.equal(result.constructorsMatch, true);
  console.log("Cloudflare type-profile runtime conformance passed.");
} finally {
  await runtime.dispose();
}
