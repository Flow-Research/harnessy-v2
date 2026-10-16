import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export const canonicalFilesystemPath = (path) => {
	try {
		return realpathSync.native(path);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return resolve(path);
		throw error;
	}
};

export const assertIsolatedRuntimeScope = ({ manifest, expectedDataDir, expectedScopeDir, message }) => {
	if (
		canonicalFilesystemPath(manifest.dataDir) !== canonicalFilesystemPath(expectedDataDir) ||
		canonicalFilesystemPath(manifest.scopeDir) !== canonicalFilesystemPath(expectedScopeDir)
	) {
		throw new Error(message);
	}
};
