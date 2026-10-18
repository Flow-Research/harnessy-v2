import { describe, expect, it } from "@effect/vitest";

import {
  hasBearerToken,
  isAllowedOrigin,
  isUnauthenticatedOAuthClientMetadataPath,
  isUnauthenticatedOAuthCallbackPath,
  isUnauthenticatedOAuthPath,
  LOCAL_LOGIN_CODE_TTL_MS,
  makeIsAuthorized,
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

  it("allows operator-added hosts on any port", () => {
    const extra = new Set(["cockpit.example"]);
    expect(isAllowedOrigin("https://cockpit.example:8443", self, extra)).toBe(true);
    expect(isAllowedOrigin("https://other.example", self, extra)).toBe(false);
  });

  it("rejects foreign, non-canonical and malformed origins", () => {
    expect(isAllowedOrigin("https://evil.example", self)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:4788/", self)).toBe(false);
    expect(isAllowedOrigin("null", self)).toBe(false);
    expect(isAllowedOrigin("not-a-url", self)).toBe(false);
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
