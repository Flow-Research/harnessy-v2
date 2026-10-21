/**
 * Overrides applied to every isolated release install.
 *
 * npm and Bun ignore `overrides` declared by dependencies, so a consumer of the
 * packed tarballs would otherwise resolve copies that the root workspace pins.
 * `@harnessy/engine` keeps `agents@0.17.3` for its declaration types, and that
 * release pins `@modelcontextprotocol/sdk@1.29.0`, below the 1.32.0 fix for
 * GHSA-22jm-h49p-29qw, GHSA-46jr-4wx8-v453, GHSA-6prh-2h8m-c8cw and
 * GHSA-rvq5-wwqv-78pq. The engine bundles its own runtime copy, so the
 * installed one supplies types only. The flat form works for npm and for Bun,
 * which supports only top-level overrides; every other consumer already
 * resolves the same version. The root workspace applies the same pin scoped to
 * `agents` (asserted in harnessy-release-contract.test.mjs).
 */
export const releaseInstallOverrides = Object.freeze({ "@modelcontextprotocol/sdk": "1.32.1" });

/** `package.json` for an isolated install of the given release tarballs. */
export const releaseInstallManifest = (dependencies) => ({
	private: true,
	dependencies,
	overrides: { ...releaseInstallOverrides, ...dependencies },
});
