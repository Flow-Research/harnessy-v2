// oxlint-disable-next-line executor/no-vitest-import -- Cloudflare pool requires Vitest 4; Effect adapter requires Vitest 5.
import { describe, expect, it } from "vitest";

import { integration } from "./authoring";

describe("authoring integration builder", () => {
  it("returns immutable fluent declarations", () => {
    const base = integration("gmail");
    const many = base.array().describe("Inbox accounts");

    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(many)).toBe(true);
    expect(base).toMatchObject({
      kind: "integration",
      slug: "gmail",
      mode: "one",
    });
    expect(many).toMatchObject({
      kind: "integration",
      slug: "gmail",
      mode: "many",
      description: "Inbox accounts",
    });
    expect(base).not.toBe(many);
  });
});
