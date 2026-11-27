import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { socialHost } from "./host";

describe("social cockpit HTTP identities", () => {
  it("requires the independent human credential, a bound browser session and same-origin confirmation", async ({
    onTestFinished,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "social-http-"));
    const operator = randomBytes(32).toString("hex");
    const agent = randomBytes(32).toString("hex");
    const daemon = randomBytes(32).toString("hex");
    const origin = "http://127.0.0.1:4788";
    const host = socialHost(dir, "test", daemon, {
      HARNESSY_SOCIAL_OPERATOR_CODE: operator,
      HARNESSY_SOCIAL_AGENT_TOKEN: agent,
      HARNESSY_SOCIAL_AGENT_ACCOUNTS: "x-fixture",
    });
    const call = (
      path: string,
      token: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) => {
      const url = new URL("/api/social/v1/" + path, origin);
      return host.handle(
        new Request(url, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: "Bearer " + token,
            origin,
            "content-type": "application/json",
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        url,
      );
    };
    onTestFinished(() => {
      host.close();
      rmSync(dir, { recursive: true, force: true });
    });
    expect((await call("accounts", daemon)).status).toBe(403);
    expect((await call("session", agent, { code: operator })).status).toBe(403);
    expect((await call("session", daemon, { code: agent })).status).toBe(403);
    expect(
      (await call("session", daemon, { code: operator }, { origin: "http://localhost:10001" }))
        .status,
    ).toBe(403);
    const login = await call("session", daemon, { code: operator });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const { csrf } = (await login.json()) as { csrf: string };
    const session = { cookie, "x-social-csrf": csrf };
    const channels = (await (await call("accounts", daemon, undefined, session)).json()) as {
      items: unknown[];
    };
    expect(channels.items).toHaveLength(2);
    expect((await call("accounts/x-fixture/check", daemon, {}, { cookie })).status).toBe(403);
    expect((await call("accounts/x-fixture/check", daemon, {}, session)).status).toBe(200);
    expect((await call("accounts/wa-fixture/check", agent, {}, session)).status).toBe(404);
    expect((await call("webhooks/whatsapp", agent, {})).status).toBe(404);
    await call("session", daemon, { code: operator });
    expect((await call("session", daemon, undefined, session)).status).toBe(401);
  });
});
