import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";

type WorkerdTarget = { os: string; arch: string; abi?: string };

export const resolveWorkerdBinary = (repoRoot: string, t: WorkerdTarget): string | null => {
  const platformMap: Record<string, string> = {
    "darwin-arm64": "@cloudflare/workerd-darwin-arm64",
    "darwin-x64": "@cloudflare/workerd-darwin-64",
    "linux-arm64": "@cloudflare/workerd-linux-arm64",
    "linux-x64": "@cloudflare/workerd-linux-64",
    "win32-x64": "@cloudflare/workerd-windows-64",
  };
  const key = [t.os, t.arch, t.abi].filter(Boolean).join("-");
  const pkg = platformMap[key];
  // Upstream has no musl or Windows arm64 workerd binary.
  if (!pkg) return null;
  const binary = t.os === "win32" ? "workerd.exe" : "workerd";
  const runtimeManifest = join(repoRoot, "packages/kernel/runtime-workerd-subprocess/package.json");
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const runtimePackage = JSON.parse(readFileSync(runtimeManifest, "utf8"));
  const expectedVersion: unknown =
    rootPackage.overrides?.workerd ?? runtimePackage.dependencies?.workerd;
  if (
    typeof expectedVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion)
  ) {
    throw new Error("workerd packaging requires an exact effective dependency version");
  }
  const findBinary = (packageRoot: string): string | null => {
    try {
      const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
      if (metadata.name !== pkg || metadata.version !== expectedVersion) return null;
    } catch {
      return null;
    }
    for (const candidate of [join(packageRoot, "bin", binary), join(packageRoot, binary)]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  };
  try {
    const req = createRequire(
      join(repoRoot, "packages/kernel/runtime-workerd-subprocess/package.json"),
    );
    const pkgJson = req.resolve(`${pkg}/package.json`);
    const resolved = findBinary(dirname(pkgJson));
    if (resolved !== null) return resolved;
  } catch {}
  const storeRoot = join(repoRoot, "node_modules/.bun");
  const sharedStoreBinary = findBinary(join(storeRoot, "node_modules", pkg));
  if (sharedStoreBinary !== null) return sharedStoreBinary;
  // Bun may materialize optional dependencies either as a direct store entry
  // or beneath the parent `workerd@...` entry. Check each store entry so both
  // layouts produce the same artifact.
  for (const entry of existsSync(storeRoot) ? readdirSync(storeRoot) : []) {
    const resolved = findBinary(join(storeRoot, entry, "node_modules", pkg));
    if (resolved !== null) return resolved;
  }
  // Keep a bounded fallback for future Bun store layouts. This still resolves
  // only the exact scoped package and binary required by the target.
  const findNested = (root: string, depth: number): string | null => {
    if (depth > 6) return null;
    const direct = findBinary(join(root, pkg));
    if (direct !== null) return direct;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = findNested(join(root, entry.name), depth + 1);
      if (nested !== null) return nested;
    }
    return null;
  };
  const nested = existsSync(storeRoot) ? findNested(storeRoot, 0) : null;
  if (nested !== null) return nested;
  throw new Error(
    `Missing ${pkg}@${expectedVersion} binary; install the locked optional dependencies for this target`,
  );
};
