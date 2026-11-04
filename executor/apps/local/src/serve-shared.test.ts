import { describe, expect, it } from "@effect/vitest";

import {
  hasBearerToken,
  isAllowedOrigin,
  isUnauthenticatedOAuthClientMetadataPath,
  isUnauthenticatedOAuthCallbackPath,
  isUnauthenticatedOAuthPath,
  allowedHostConnectSources,
  LOCAL_LOGIN_CODE_TTL_MS,
  makeIsAuthorized,
  parseAllowedHost,
  parseWebConnectSources,
  makeLocalLoginCodes,
  selfLoopbackOrigins,
} from "./serve-shared";

const self = selfLoopbackOrigins(4788);
const req = (headers: Record<string, string>): Request =>
  new Request("http://127.0.0.1/api/scope", { headers });

describe("isAllowedOrigin", () => {
  it("allows only the server's own exact loopback origins", () => {
    expect(isAllowedOrigin("http://127.0.0.1:4788", self)).toBe(true);
    expect(isAllowedOrigin("http://localhost:4788", self)).toBe(true);
    expect(isAllowedOrigin("http://[::1]:4788", self)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:4789", self)).toBe(false);
    expect(isAllowedOrigin("http://localhost:5173", self)).toBe(false);
    expect(isAllowedOrigin("https://localhost:4788", self)).toBe(false);
  });

  it("allows operator-added hosts on any port unless the entry names one", () => {
    const extra = [parseAllowedHost("cockpit.example"), parseAllowedHost("pinned.example:8443")];
    expect(isAllowedOrigin("https://cockpit.example:8443", self, extra)).toBe(true);
    expect(isAllowedOrigin("http://cockpit.example", self, extra)).toBe(true);
    expect(isAllowedOrigin("https://pinned.example:8443", self, extra)).toBe(true);
    expect(isAllowedOrigin("https://pinned.example", self, extra)).toBe(false);
    expect(isAllowedOrigin("https://other.example", self, extra)).toBe(false);
  });

  it("matches IPv6 entries with or without brackets", () => {
    for (const entry of ["fd7a:115c::1", "[fd7a:115c::1]", " [FD7A:115C::1] "]) {
      const extra = [parseAllowedHost(entry)];
      expect(isAllowedOrigin("http://[fd7a:115c::1]:4788", self, extra)).toBe(true);
      expect(isAllowedOrigin("http://[fd7a:115c::2]:4788", self, extra)).toBe(false);
    }
    const pinned = [parseAllowedHost("[fd7a:115c::1]:4788")];
    expect(isAllowedOrigin("http://[fd7a:115c::1]:4788", self, pinned)).toBe(true);
    expect(isAllowedOrigin("http://[fd7a:115c::1]:4789", self, pinned)).toBe(false);
  });

  it("only grants http and https origins for operator-added hosts", () => {
    const extra = [parseAllowedHost("cockpit.example")];
    expect(isAllowedOrigin("ws://cockpit.example", self, extra)).toBe(false);
    expect(isAllowedOrigin("ftp://cockpit.example", self, extra)).toBe(false);
  });

  it("rejects foreign, non-canonical and malformed origins", () => {
    expect(isAllowedOrigin("https://evil.example", self)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:4788/", self)).toBe(false);
    expect(isAllowedOrigin("null", self)).toBe(false);
    expect(isAllowedOrigin("not-a-url", self)).toBe(false);
  });
});

describe("parseAllowedHost", () => {
  it("trims and lowercases entries", () => {
    expect(parseAllowedHost("  Cockpit.Example:8443 ")).toEqual({
      host: "cockpit.example",
      port: 8443,
    });
  });

  it("requires a port for loopback hosts", () => {
    for (const entry of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
      expect(() => parseAllowedHost(entry)).toThrow(/loopback host needs an explicit port/);
    }
    expect(parseAllowedHost("localhost:5173")).toEqual({ host: "localhost", port: 5173 });
    expect(parseAllowedHost("[::1]:5173")).toEqual({ host: "::1", port: 5173 });
  });

  it("rejects URLs, paths, credentials and bad ports", () => {
    for (const entry of [
      "https://cockpit.example",
      "cockpit.example/path",
      "user@cockpit.example",
      "cockpit.example:0",
      "cockpit.example:70000",
      "",
      "*",
    ]) {
      expect(() => parseAllowedHost(entry), entry).toThrow(/invalid --allowed-host/);
    }
  });
});

describe("connect-src sources", () => {
  it("turns allowed hosts into http and https sources, skipping IPv6", () => {
    expect(
      allowedHostConnectSources([
        parseAllowedHost("cockpit.example"),
        parseAllowedHost("pinned.example:8443"),
        parseAllowedHost("[fd7a::1]:4788"),
      ]),
    ).toEqual([
      "http://cockpit.example:*",
      "https://cockpit.example:*",
      "http://pinned.example:8443",
      "https://pinned.example:8443",
    ]);
  });

  it("parses EXECUTOR_WEB_CONNECT_SRC origins and the any opt-in", () => {
    expect(parseWebConnectSources(undefined)).toEqual([]);
    expect(parseWebConnectSources("https://exec.example, http://100.64.0.2:4788")).toEqual([
      "https://exec.example",
      "http://100.64.0.2:4788",
    ]);
    expect(parseWebConnectSources("any")).toEqual(["http:", "https:"]);
    for (const value of ["exec.example", "https://exec.example/api", "ws://exec.example", "*"]) {
      expect(() => parseWebConnectSources(value), value).toThrow(/EXECUTOR_WEB_CONNECT_SRC/);
    }
  });
});

describe("makeLocalLoginCodes", () => {
  it("redeems a code once and never after it expires", () => {
    let now = 1_000;
    const codes = makeLocalLoginCodes(() => now);
    const first = codes.mint();
    expect(codes.redeem(first)).toBe(true);
    expect(codes.redeem(first)).toBe(false);

    const second = codes.mint();
    now += LOCAL_LOGIN_CODE_TTL_MS;
    expect(codes.redeem(second)).toBe(false);
    expect(codes.redeem("unknown")).toBe(false);
  });

  it("drops the oldest code past sixteen outstanding codes", () => {
    const codes = makeLocalLoginCodes(() => 0);
    const minted = Array.from({ length: 17 }, () => codes.mint());
    expect(codes.redeem(minted[0]!)).toBe(false);
    expect(codes.redeem(minted[16]!)).toBe(true);
    expect(codes.redeem(minted[1]!)).toBe(true);
  });
});

describe("makeIsAuthorized", () => {
  const isAuthorized = makeIsAuthorized("secret-token");

  it("accepts a matching bearer token", () => {
    expect(isAuthorized(req({ authorization: "Bearer secret-token" }))).toBe(true);
    expect(hasBearerToken(req({ authorization: "bearer secret-token" }), "secret-token")).toBe(
      true,
    );
  });

  it("rejects a missing or wrong token", () => {
    expect(isAuthorized(req({}))).toBe(false);
    expect(isAuthorized(req({ authorization: "Bearer wrong" }))).toBe(false);
    expect(isAuthorized(req({ authorization: "Basic secret-token" }))).toBe(false);
  });
});

describe("isUnauthenticatedOAuthCallbackPath", () => {
  it("exempts only the callback path, not the await poll", () => {
    expect(isUnauthenticatedOAuthCallbackPath("/api/oauth/callback")).toBe(true);
    expect(isUnauthenticatedOAuthCallbackPath("/api/oauth/callback/x")).toBe(true);
    expect(isUnauthenticatedOAuthCallbackPath("/api/oauth/await/session-1")).toBe(false);
    expect(isUnauthenticatedOAuthCallbackPath("/api/scope")).toBe(false);
  });
});

describe("isUnauthenticatedOAuthClientMetadataPath", () => {
  it("exempts the CIMD documents the OAuth provider fetches", () => {
    expect(isUnauthenticatedOAuthClientMetadataPath("/api/oauth/client-id-metadata.json")).toBe(
      true,
    );
    expect(
      isUnauthenticatedOAuthClientMetadataPath("/api/oauth/client-id-metadata/default.json"),
    ).toBe(true);
    expect(
      isUnauthenticatedOAuthClientMetadataPath("/api/oauth/client-id-metadata/local.json"),
    ).toBe(true);
  });

  it("does not exempt OAuth result polling or arbitrary API paths", () => {
    expect(isUnauthenticatedOAuthPath("/api/oauth/client-id-metadata/local.json")).toBe(true);
    expect(isUnauthenticatedOAuthPath("/api/oauth/callback")).toBe(true);
    expect(isUnauthenticatedOAuthPath("/api/oauth/await/session-1")).toBe(false);
    expect(isUnauthenticatedOAuthPath("/api/connections")).toBe(false);
  });
});
