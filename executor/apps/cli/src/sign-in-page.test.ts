import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isLoopbackHttpOrigin,
  signInPageOpenCommand,
  STALE_SIGN_IN_PAGE_MS,
  writeSignInPage,
} from "./sign-in-page";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exec-sign-in-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isLoopbackHttpOrigin", () => {
  it("accepts only canonical plain-http loopback origins", () => {
    expect(isLoopbackHttpOrigin("http://localhost:4788")).toBe(true);
    expect(isLoopbackHttpOrigin("http://127.0.0.1:4788")).toBe(true);
    expect(isLoopbackHttpOrigin("http://[::1]:4788")).toBe(true);
    expect(isLoopbackHttpOrigin("https://localhost:4788")).toBe(false);
    expect(isLoopbackHttpOrigin("http://100.64.0.1:4788")).toBe(false);
    expect(isLoopbackHttpOrigin("http://localhost.evil.example:4788")).toBe(false);
    expect(isLoopbackHttpOrigin("http://localhost:4788/")).toBe(false);
    expect(isLoopbackHttpOrigin("not a url")).toBe(false);
  });
});

describe("writeSignInPage", () => {
  it("writes an owner-only redirect page that carries the code only in its body", () => {
    const target = `http://localhost:4788/#_code=${"c".repeat(43)}`;
    const path = writeSignInPage(dir, target);

    expect(path.startsWith(dir)).toBe(true);
    expect(path).not.toContain("_code");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const html = readFileSync(path, "utf8");
    expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${target}">`);
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("escapes the target so it cannot break out of the attribute", () => {
    const path = writeSignInPage(dir, 'http://localhost:4788/#_code="><script>x</script>');
    const html = readFileSync(path, "utf8");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("removes stale sign-in pages and keeps fresh and unrelated files", () => {
    const now = Date.now();
    const stale = writeSignInPage(dir, "http://localhost:4788/#_code=a", now);
    const old = new Date(now - STALE_SIGN_IN_PAGE_MS - 1_000);
    utimesSync(stale, old, old);
    const fresh = writeSignInPage(dir, "http://localhost:4788/#_code=b", now);
    writeFileSync(join(dir, "auth.json"), "{}");

    const latest = writeSignInPage(dir, "http://localhost:4788/#_code=c", now);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(latest)).toBe(true);
    expect(readdirSync(dir)).toContain("auth.json");
  });
});

describe("signInPageOpenCommand", () => {
  const page = `/tmp/x/server-control/sign-in-${"a".repeat(32)}.html`;

  it("opens the page as a file URL in one argument", () => {
    expect(signInPageOpenCommand(page, "darwin")).toEqual(["open", [`file://${page}`]]);
    expect(signInPageOpenCommand(page, "linux")).toEqual(["xdg-open", [`file://${page}`]]);
  });

  it("refuses anything but an absolute sign-in page path", () => {
    expect(signInPageOpenCommand("sign-in-" + "a".repeat(32) + ".html", "darwin")).toBeUndefined();
    expect(signInPageOpenCommand("/Windows/System32/calc.exe", "win32")).toBeUndefined();
    expect(signInPageOpenCommand("/tmp/x/sign-in-short.html", "darwin")).toBeUndefined();
  });
});
