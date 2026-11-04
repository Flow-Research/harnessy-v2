import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  existsSync,
  mkdirSync,
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

import { signInPageName } from "@executor-js/local";

import {
  chooseSignInDelivery,
  isLoopbackHttpOrigin,
  loopbackSignInUrl,
  macDefaultBrowserBundleId,
  signInPageOpenCommand,
  STALE_SIGN_IN_PAGE_MS,
  writeSignInPage,
} from "./sign-in-page";
import { blankDataDirRefusal } from "./local-server-manifest";

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
    const code = "c".repeat(43);
    const target = `http://localhost:4788/auth/sign-in#_code=${code}`;
    const path = writeSignInPage(dir, "http://localhost:4788", code);

    expect(path).toBe(join(dir, signInPageName(code)));
    expect(path).not.toContain(code);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const html = readFileSync(path, "utf8");
    expect(html).toContain(`<script>location.replace(${JSON.stringify(target)});</script>`);
    expect(html).toContain(
      `<noscript><meta http-equiv="refresh" content="0;url=${target}"></noscript>`,
    );
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("replaces itself in history instead of adding a meta-refresh entry", () => {
    const html = readFileSync(
      writeSignInPage(dir, "http://localhost:4788", "d".repeat(43)),
      "utf8",
    );
    // A bare meta refresh pushes a history entry in some browsers; it is only
    // the no-script fallback now.
    expect(html.replace(/<noscript>.*<\/noscript>/s, "")).not.toContain("http-equiv");
    expect(html).toContain("location.replace(");
  });

  it("escapes the target so it cannot break out of the script or the attribute", () => {
    const path = writeSignInPage(dir, "http://localhost:4788", '"><script>x</script>');
    const html = readFileSync(path, "utf8");
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("</script>x");
    expect(html).toContain("\\u003cscript\\u003ex");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("removes stale sign-in pages and keeps fresh and unrelated files", () => {
    const now = Date.now();
    const stale = writeSignInPage(dir, "http://localhost:4788", "a", now);
    const old = new Date(now - STALE_SIGN_IN_PAGE_MS - 1_000);
    utimesSync(stale, old, old);
    const fresh = writeSignInPage(dir, "http://localhost:4788", "b", now);
    writeFileSync(join(dir, "auth.json"), "{}");

    const latest = writeSignInPage(dir, "http://localhost:4788", "c", now);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(latest)).toBe(true);
    expect(readdirSync(dir)).toContain("auth.json");
  });
});

describe("writeSignInPage sweep races", () => {
  it("does not fail when the sweep finds an unreadable or vanished entry", () => {
    // A directory with a page-like name: lstat succeeds, unlink fails (EPERM/EISDIR).
    const stuck = join(dir, `sign-in-${"d".repeat(32)}.html`);
    mkdirSync(stuck);
    const old = new Date(Date.now() - STALE_SIGN_IN_PAGE_MS - 1_000);
    utimesSync(stuck, old, old);
    expect(() => writeSignInPage(dir, "http://localhost:4788", "e")).not.toThrow();
  });
});

describe("blankDataDirRefusal", () => {
  it("refuses a set-but-blank EXECUTOR_DATA_DIR only", () => {
    expect(blankDataDirRefusal({ EXECUTOR_DATA_DIR: "" })).toMatch(/set but empty/);
    expect(blankDataDirRefusal({ EXECUTOR_DATA_DIR: "  " })).toMatch(/set but empty/);
    expect(blankDataDirRefusal({ EXECUTOR_DATA_DIR: "/tmp/x" })).toBeNull();
    expect(blankDataDirRefusal({})).toBeNull();
  });
});

describe("signInPageOpenCommand", () => {
  const page = `/tmp/x/server-control/sign-in-${"a".repeat(32)}.html`;

  it("opens the page as a file URL in one argument", () => {
    expect(signInPageOpenCommand(page, "darwin")).toEqual(["open", [`file://${page}`]]);
    expect(signInPageOpenCommand(page, "linux")).toEqual(["xdg-open", [`file://${page}`]]);
  });

  it("opens the page in the macOS default browser, not the .html handler", () => {
    expect(signInPageOpenCommand(page, "darwin", "com.google.Chrome")).toEqual([
      "open",
      ["-b", "com.google.Chrome", `file://${page}`],
    ]);
    expect(signInPageOpenCommand(page, "darwin", "-a Evil")).toEqual(["open", [`file://${page}`]]);
    expect(signInPageOpenCommand(page, "linux", "com.google.Chrome")).toEqual([
      "xdg-open",
      [`file://${page}`],
    ]);
  });

  it("refuses anything but an absolute sign-in page path", () => {
    expect(signInPageOpenCommand("sign-in-" + "a".repeat(32) + ".html", "darwin")).toBeUndefined();
    expect(signInPageOpenCommand("/Windows/System32/calc.exe", "win32")).toBeUndefined();
    expect(signInPageOpenCommand("/tmp/x/sign-in-short.html", "darwin")).toBeUndefined();
  });
});

describe("macDefaultBrowserBundleId", () => {
  const handlers = (entries: ReadonlyArray<Record<string, string>>) =>
    JSON.stringify({ LSHandlers: entries });

  it("reads the http handler from the LaunchServices list", () => {
    expect(
      macDefaultBrowserBundleId(
        handlers([
          { LSHandlerContentType: "public.html", LSHandlerRoleAll: "com.microsoft.vscode" },
          { LSHandlerURLScheme: "http", LSHandlerRoleAll: "org.mozilla.firefox" },
        ]),
      ),
    ).toBe("org.mozilla.firefox");
  });

  it("falls back to Safari, the system default, without a usable entry", () => {
    expect(macDefaultBrowserBundleId(undefined)).toBe("com.apple.Safari");
    expect(macDefaultBrowserBundleId("not json")).toBe("com.apple.Safari");
    expect(
      macDefaultBrowserBundleId(
        handlers([{ LSHandlerURLScheme: "http", LSHandlerRoleAll: "x y" }]),
      ),
    ).toBe("com.apple.Safari");
  });
});

describe("chooseSignInDelivery", () => {
  const snapDir = "/var/lib/snapd/desktop/applications";
  const flatpakDir = "/home/me/.local/share/flatpak/exports/share/applications";

  it("uses the loopback URL for a snap or flatpak default browser on Linux", () => {
    expect(
      chooseSignInDelivery({
        platform: "linux",
        env: { HOME: "/home/me" },
        defaultBrowserDesktopId: () => "firefox_firefox.desktop",
        exists: (path) => path === `${snapDir}/firefox_firefox.desktop`,
      }),
    ).toBe("loopback-url");
    expect(
      chooseSignInDelivery({
        platform: "linux",
        env: { HOME: "/home/me" },
        defaultBrowserDesktopId: () => "org.chromium.Chromium.desktop",
        exists: (path) => path === `${flatpakDir}/org.chromium.Chromium.desktop`,
      }),
    ).toBe("loopback-url");
  });

  it("keeps the file page for other browsers and platforms", () => {
    const base = { env: { HOME: "/home/me" }, exists: () => false };
    expect(
      chooseSignInDelivery({
        ...base,
        platform: "linux",
        defaultBrowserDesktopId: () => "firefox.desktop",
      }),
    ).toBe("file");
    expect(
      chooseSignInDelivery({
        ...base,
        platform: "linux",
        defaultBrowserDesktopId: () => undefined,
      }),
    ).toBe("file");
    expect(
      chooseSignInDelivery({ ...base, platform: "linux", defaultBrowserDesktopId: () => "../x" }),
    ).toBe("file");
    expect(chooseSignInDelivery({ ...base, platform: "darwin" })).toBe("file");
  });

  it("honours EXECUTOR_SIGN_IN", () => {
    expect(chooseSignInDelivery({ platform: "darwin", env: { EXECUTOR_SIGN_IN: "url" } })).toBe(
      "loopback-url",
    );
    expect(
      chooseSignInDelivery({
        platform: "linux",
        env: { EXECUTOR_SIGN_IN: "file", HOME: "/home/me" },
        defaultBrowserDesktopId: () => "firefox_firefox.desktop",
        exists: () => true,
      }),
    ).toBe("file");
  });
});

describe("loopbackSignInUrl", () => {
  const code = "k".repeat(43);

  it("puts the code in the fragment of the daemon's exchange page only", () => {
    const url = loopbackSignInUrl("http://127.0.0.1:4788", code)!;
    expect(url).toBe(`http://127.0.0.1:4788/auth/sign-in#_code=${code}`);
    const parsed = new URL(url);
    expect(parsed.pathname + parsed.search).not.toContain(code);
  });

  it("refuses a non-loopback origin or a malformed code", () => {
    expect(loopbackSignInUrl("https://localhost:4788", code)).toBeUndefined();
    expect(loopbackSignInUrl("http://100.64.0.1:4788", code)).toBeUndefined();
    expect(loopbackSignInUrl("http://127.0.0.1:4788", "short")).toBeUndefined();
  });
});
