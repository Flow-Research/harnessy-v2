"use strict";

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const SUPPORTED_ARCHITECTURES = new Set(["arm64", "x64"]);

const resolveHarnessyExecutorPlatform = (platform, arch) => {
	if (!SUPPORTED_PLATFORMS.has(platform) || !SUPPORTED_ARCHITECTURES.has(arch)) {
		throw new Error(`unsupported platform: ${platform}-${arch}`);
	}
	return {
		arch,
		binary: platform === "win32" ? "executor.exe" : "executor",
		platform: platform === "win32" ? "windows" : platform,
	};
};

module.exports = { resolveHarnessyExecutorPlatform };
