import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { bootstrapLocalAuthToken } from "./local-auth";
import { getExecutorServerConnection, setExecutorServerConnection } from "./server-connection";

const CODE = "c".repeat(43);
const STORAGE_KEY = "executor.authToken";

type FetchStub = (input: string, init: RequestInit) => Promise<Response>;

let events: Array<string>;
let fetchCalls: Array<{ readonly input: string; readonly body: unknown }>;
let storage: Map<string, string>;
const initialConnection = getExecutorServerConnection();

const install = (href: string, fetchStub: FetchStub): void => {
  Reflect.set(globalThis, "window", {
    location: { href },
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        events.push(`replace ${url}`);
      },
    },
  });
  Reflect.set(globalThis, "localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  });
  Reflect.set(globalThis, "fetch", (input: string, init: RequestInit) => {
    events.push(`fetch ${input}`);
    fetchCalls.push({ input, body: init.body });
    return fetchStub(input, init);
  });
};

const bearerToken = (): string | undefined => {
  const auth = getExecutorServerConnection().auth;
  return auth?.kind === "bearer" ? auth.token : undefined;
};

const savedFetch = globalThis.fetch;

beforeEach(() => {
  events = [];
  fetchCalls = [];
  storage = new Map();
  // In a browser the initial connection is the serving origin.
  setExecutorServerConnection({ kind: "http", origin: "http://localhost:4788" });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.set(globalThis, "fetch", savedFetch);
  setExecutorServerConnection(initialConnection);
});

describe("bootstrapLocalAuthToken sign-in code", () => {
  it("strips the code from the URL before exchanging it, then applies the token", async () => {
    install(`http://localhost:4788/tools?x=1#_code=${CODE}&tab=2`, async () =>
      Response.json({ token: "bearer-1" }),
    );

    await bootstrapLocalAuthToken();

    expect(events).toEqual(["replace /tools?x=1#tab=2", "fetch /api/local-auth/exchange"]);
    expect(fetchCalls[0]?.body).toBe(JSON.stringify({ code: CODE }));
    expect(storage.get(STORAGE_KEY)).toBe("bearer-1");
    expect(bearerToken()).toBe("bearer-1");
  });

  it("drops an empty fragment entirely", async () => {
    install(`http://localhost:4788/#_code=${CODE}`, async () => Response.json({ token: "t" }));
    await bootstrapLocalAuthToken();
    expect(events[0]).toBe("replace /");
  });

  it("falls back to the stored token when the code is rejected", async () => {
    install(`http://localhost:4788/#_code=${CODE}`, async () =>
      Response.json({ error: "invalid_code" }, { status: 401 }),
    );
    storage.set(STORAGE_KEY, "stored-token");

    await bootstrapLocalAuthToken();

    expect(events[0]).toBe("replace /");
    expect(bearerToken()).toBe("stored-token");
  });

  it("gives up on a hung exchange after the timeout and still boots", async () => {
    install(
      `http://localhost:4788/#_code=${CODE}`,
      // Answers only once aborted, so the bootstrap can finish only via the timeout.
      (_input, init) =>
        new Promise<Response>((resolve) => {
          init.signal?.addEventListener("abort", () =>
            resolve(Response.json({ error: "timeout" }, { status: 504 })),
          );
        }),
    );
    storage.set(STORAGE_KEY, "stored-token");

    await bootstrapLocalAuthToken({ exchangeTimeoutMs: 20 });

    expect(bearerToken()).toBe("stored-token");
  });

  it("does not call the exchange without a code", async () => {
    install("http://localhost:4788/#tab=2", async () => Response.json({ token: "unused" }));
    storage.set(STORAGE_KEY, "stored-token");

    await bootstrapLocalAuthToken();

    expect(fetchCalls).toEqual([]);
    expect(bearerToken()).toBe("stored-token");
  });
});

describe("bootstrapLocalAuthToken issuing origin", () => {
  it("does not attach the local token to another selected server", async () => {
    setExecutorServerConnection({ kind: "http", origin: "https://other-executor.example" });
    install(`http://localhost:4788/#_code=${CODE}`, async () => Response.json({ token: "local" }));

    await bootstrapLocalAuthToken();

    expect(getExecutorServerConnection().origin).toBe("https://other-executor.example");
    expect(bearerToken()).toBeUndefined();
    // The token is still kept for the serving origin.
    expect(storage.get(STORAGE_KEY)).toBe("local");
  });

  it("does not attach a stored token to another selected server either", async () => {
    setExecutorServerConnection({ kind: "http", origin: "http://localhost:9999" });
    install("http://localhost:4788/", async () => Response.json({}));
    storage.set(STORAGE_KEY, "stored-token");

    await bootstrapLocalAuthToken();

    expect(bearerToken()).toBeUndefined();
  });

  it("attaches it to the serving origin", async () => {
    install("http://localhost:4788/tools", async () => Response.json({}));
    storage.set(STORAGE_KEY, "stored-token");

    await bootstrapLocalAuthToken();

    expect(bearerToken()).toBe("stored-token");
  });
});
