import { afterEach, describe, expect, it } from "@effect/vitest";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkerdBinary } from "./workerd-binary";

const roots: string[] = [];
const target = { os: "linux", arch: "x64" };
const pkg = "@cloudflare/workerd-linux-64";
const pinned = "1.20260708.1";
const other = "1.20260804.1";

function fixture(override: string | undefined = pinned) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workerd-resolution-")));
  roots.push(root);
  const runtime = join(root, "packages/kernel/runtime-workerd-subprocess");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ overrides: { workerd: override } }));
  writeFileSync(
    join(runtime, "package.json"),
    JSON.stringify({ dependencies: { workerd: pinned } }),
  );
  return root;
}

function binary(root: string, version: string, location: string, name = pkg, packagePath = pkg) {
  const directory = join(root, location, packagePath);
  mkdirSync(join(directory, "bin"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version }));
  const path = join(directory, "bin/workerd");
  writeFileSync(path, "test fixture; never executed");
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workerd build dependency resolution", () => {
  it("keeps unsupported targets unavailable without inspecting dependencies", () => {
    expect(resolveWorkerdBinary("/unused", { os: "win32", arch: "arm64" })).toBeNull();
  });

  it.each(["arm64", "x64"])("does not package a GNU binary for Linux musl %s", (arch) => {
    const root = fixture();
    const platformPackage = arch === "arm64" ? "@cloudflare/workerd-linux-arm64" : pkg;
    binary(root, pinned, "node_modules", platformPackage, platformPackage);
    expect(resolveWorkerdBinary(root, { os: "linux", arch, abi: "musl" })).toBeNull();
  });

  it("preserves a correct directly resolved dependency", () => {
    const root = fixture();
    const correct = binary(root, pinned, "node_modules");
    binary(root, other, "node_modules/.bun/a-other/node_modules");
    expect(resolveWorkerdBinary(root, target)).toBe(correct);
  });

  it("ignores alternate direct, shared and earlier store versions", () => {
    const root = fixture();
    binary(root, other, "node_modules");
    binary(root, other, "node_modules/.bun/node_modules");
    binary(root, other, "node_modules/.bun/a-other/node_modules");
    const correct = binary(root, pinned, "node_modules/.bun/z-pinned/node_modules");
    expect(resolveWorkerdBinary(root, target)).toBe(correct);
  });

  it("checks the pinned version in nested Bun layouts too", () => {
    const root = fixture();
    binary(root, other, "node_modules/.bun/a/inner/node_modules");
    const correct = binary(root, pinned, "node_modules/.bun/z/inner/node_modules");
    expect(resolveWorkerdBinary(root, target)).toBe(correct);
  });

  it("fails clearly when only another version exists", () => {
    const root = fixture();
    binary(root, other, "node_modules/.bun/a/node_modules");
    expect(() => resolveWorkerdBinary(root, target)).toThrow(`Missing ${pkg}@${pinned} binary`);
  });

  it("fails clearly when no store or target package exists", () => {
    expect(() => resolveWorkerdBinary(fixture(), target)).toThrow(
      `Missing ${pkg}@${pinned} binary`,
    );
  });

  it("uses the effective root override instead of the runtime declaration", () => {
    const root = fixture(other);
    binary(root, pinned, "node_modules");
    const correct = binary(root, other, "node_modules/.bun/override/node_modules");
    expect(resolveWorkerdBinary(root, target)).toBe(correct);
  });

  it("uses the exact runtime declaration when no override exists", () => {
    const root = fixture();
    writeFileSync(join(root, "package.json"), "{}");
    const correct = binary(root, pinned, "node_modules");
    expect(resolveWorkerdBinary(root, target)).toBe(correct);
  });

  it("rejects ambiguous dependency ranges and incorrectly named packages", () => {
    expect(() => resolveWorkerdBinary(fixture("^1.0.0"), target)).toThrow(
      "exact effective dependency version",
    );
    const root = fixture();
    binary(root, pinned, "node_modules", "different-package");
    expect(() => resolveWorkerdBinary(root, target)).toThrow(`Missing ${pkg}@${pinned} binary`);
  });
});
