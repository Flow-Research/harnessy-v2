import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import appsClientPlugin, {
  CUSTOM_TOOLS_LABEL,
  CUSTOM_TOOLS_PLUGIN_KEY,
  createCustomToolSourceEffect,
  formatSyncErrors,
  listCustomToolDirectoriesEffect,
  listCustomToolSources,
  parseGitSourceUrl,
  removeCustomToolSourceEffect,
  slugifyCustomToolsAppName,
  suggestCustomToolsAppName,
  syncCustomToolSourceEffect,
  syncStatusLabel,
  type AppSourceRecord,
  type CustomToolsFetch,
} from "./plugin-client";
import {
  directorySourceVerdict,
  sourcePanelModel,
  syncNoticeFromResult,
} from "./source-panel-model";
import { directoryBrowserRows } from "./source-panel-model";

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const demoSource: AppSourceRecord = {
  slug: "demo-tools",
  app: "demo-tools",
  kind: "git",
  config: {
    kind: "git",
    url: "https://gitlab.com/acme/demo-tools.git",
    ref: "main",
    tokenProvider: "default",
    tokenItemId: "apps/source-tokens/demo-tools",
  },
  sourceRef: "abc123def456",
  description: "Demo tools",
  status: {
    type: "published",
    at: Date.parse("2026-07-06T12:00:00.000Z"),
    tools: ["repo-summary", "stale-issues"],
  },
  updatedAt: Date.parse("2026-07-06T12:00:00.000Z"),
};

describe("custom tools console client", () => {
  it("registers the Apps integration plugin", () => {
    const plugin = appsClientPlugin({ sourceKinds: ["git"] });

    expect(plugin.id).toBe(CUSTOM_TOOLS_PLUGIN_KEY);
    expect(plugin.integrationPlugin?.label).toBe(CUSTOM_TOOLS_LABEL);
  });

  it("validates and suggests generic https Git repository URLs", () => {
    expect(parseGitSourceUrl("https://github.com/UsefulSoftwareCo/executor.git")).toMatchObject({
      ok: true,
      name: "executor",
      url: "https://github.com/UsefulSoftwareCo/executor.git",
    });
    expect(parseGitSourceUrl("https://gitlab.com/acme/tools")).toMatchObject({
      ok: true,
      name: "tools",
    });
    expect(parseGitSourceUrl("ssh://gitlab.com/acme/tools")).toMatchObject({
      ok: false,
      message: "Git repository URLs must use http or https.",
    });
    expect(parseGitSourceUrl("https://x:secret@gitlab.com/acme/tools")).toMatchObject({
      ok: false,
      message: "Do not include credentials in the URL. Use the token field.",
    });
    expect(suggestCustomToolsAppName("https://gitlab.com/acme/tools.git")).toBe("tools");
    expect(slugifyCustomToolsAppName("Acme Tools!")).toBe("acme-tools");
  });

  it("uses the new source routes and keeps token-bearing input out of read responses", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    let createBody = "";
    const fetchImpl: CustomToolsFetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/apps/sources" && init?.method === "POST") {
        createBody = String(init.body);
        return jsonResponse({ source: demoSource });
      }
      if (url === "/api/apps/sources") {
        return jsonResponse({ sources: [demoSource] });
      }
      if (url === "/api/apps/sources/demo-tools/sync") {
        return jsonResponse({
          status: "up-to-date",
          sourceRef: "abc123def456",
          tools: ["repo-summary", "stale-issues"],
        });
      }
      if (url === "/api/apps/sources/demo-tools") {
        return jsonResponse({ removed: true });
      }
      if (url === "/api/apps/fs/dirs?path=%2FUsers%2Fada%2Ftools&includeHidden=true") {
        return jsonResponse({
          path: "/Users/ada/tools",
          parent: "/Users/ada",
          dirs: [
            { name: "alpha", path: "/Users/ada/tools/alpha", isSymlink: false, hasTools: true },
          ],
          source: { toolFiles: ["greet.ts"], skipped: [], hasPackageJson: true },
        });
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    };

    const created = await Effect.runPromise(
      createCustomToolSourceEffect(
        {
          kind: "git",
          slug: "demo-tools",
          app: "demo-tools",
          url: "https://gitlab.com/acme/demo-tools.git",
          token: "ghp_secret",
        },
        fetchImpl,
      ),
    );
    const listed = await listCustomToolSources(fetchImpl);
    const synced = await Effect.runPromise(syncCustomToolSourceEffect("demo-tools", fetchImpl));
    const removed = await Effect.runPromise(removeCustomToolSourceEffect("demo-tools", fetchImpl));
    const dirs = await Effect.runPromise(
      listCustomToolDirectoriesEffect({ path: "/Users/ada/tools", includeHidden: true }, fetchImpl),
    );

    expect(created.source.slug).toBe("demo-tools");
    expect(createBody).toContain("ghp_secret");
    expect(JSON.stringify(listed)).not.toContain("ghp_secret");
    expect(syncStatusLabel(synced)).toBe("Already up to date.");
    expect(removed).toEqual({ removed: true });
    expect(dirs.dirs).toEqual([
      { name: "alpha", path: "/Users/ada/tools/alpha", isSymlink: false, hasTools: true },
    ]);
    expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
      "POST /api/apps/sources",
      "GET /api/apps/sources",
      "POST /api/apps/sources/demo-tools/sync",
      "DELETE /api/apps/sources/demo-tools",
      "GET /api/apps/fs/dirs?path=%2FUsers%2Fada%2Ftools&includeHidden=true",
    ]);
  });

  it("models the source panel and sync notice", () => {
    const panel = sourcePanelModel(demoSource, {
      now: Date.parse("2026-07-06T12:05:00.000Z"),
    });
    const notice = syncNoticeFromResult(
      {
        status: "published",
        sourceRef: "def456abc123",
        tools: ["repo-summary", "stale-issues", "extra-tool"],
      },
      demoSource.status.type === "published" ? demoSource.status.tools : [],
    );

    expect(panel.title).toBe("demo-tools");
    expect(panel.source).toBe("Git repository: https://gitlab.com/acme/demo-tools.git @ main");
    expect(panel.status).toBe("Published 5m ago");
    expect(panel.sourceRef).toBe("abc123def456");
    expect(panel.tools).toEqual(["repo-summary", "stale-issues"]);
    expect(notice.message).toBe("Published 3 tools.");
    expect(notice.added).toEqual(["extra-tool"]);
    expect(notice.sourceRef).toBe("def456abc123");
  });

  it("models the directory browser rows", () => {
    expect(
      directoryBrowserRows({
        path: "/Users/ada/tools",
        parent: "/Users/ada",
        dirs: [
          { name: "alpha", path: "/Users/ada/tools/alpha", isSymlink: false, hasTools: false },
          { name: "linked", path: "/Users/ada/tools/linked", isSymlink: true, hasTools: false },
        ],
        source: { toolFiles: [], skipped: [], hasPackageJson: false },
      }),
    ).toEqual([
      { kind: "parent", name: "..", path: "/Users/ada" },
      {
        kind: "dir",
        name: "alpha",
        path: "/Users/ada/tools/alpha",
        isSymlink: false,
        hasTools: false,
      },
      {
        kind: "dir",
        name: "linked",
        path: "/Users/ada/tools/linked",
        isSymlink: true,
        hasTools: false,
      },
    ]);
  });

  it("models directory source verdicts", () => {
    expect(
      directorySourceVerdict({
        path: "/repo",
        parent: null,
        dirs: [{ name: "tools", path: "/repo/tools", isSymlink: false, hasTools: false }],
        source: { toolFiles: [], skipped: [], hasPackageJson: false },
      }),
    ).toEqual({
      type: "empty-tools",
      message: "tools/ has no tool files (tools/<name>.ts)",
    });
    expect(
      directorySourceVerdict({
        path: "/repo",
        parent: null,
        dirs: [],
        source: { toolFiles: [], skipped: [], hasPackageJson: false },
      }),
    ).toEqual({
      type: "missing-tools",
      message: "No tools/ folder. Pick a folder containing tools/<name>.ts files.",
    });
    expect(
      directorySourceVerdict({
        path: "/repo",
        parent: null,
        dirs: [],
        source: {
          toolFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
          skipped: [],
          hasPackageJson: true,
        },
      }),
    ).toEqual({
      type: "valid",
      message: "6 tools found",
      visibleTools: ["a", "b", "c", "d", "e"],
      moreCount: 1,
    });
  });

  it("formats failed sync diagnostics by stage", () => {
    const errors = formatSyncErrors({
      status: "failed",
      tools: [],
      errors: [
        {
          stage: "collect",
          message: "schema export failed",
          diagnostics: [{ path: "tools/x.ts", message: "unsupported schema" }],
        },
      ],
    });

    expect(errors).toEqual(["collect: schema export failed", "tools/x.ts: unsupported schema"]);
  });
});
