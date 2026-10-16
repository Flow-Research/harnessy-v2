export const HARNESSY_PACKAGE_NAMES = new Set([
	"@harnessy/core",
	"@harnessy/engine",
	"@harnessy/executor",
	"@harnessy/local-host",
	"@harnessy/sdk",
	"@harnessy/capability-harnessy-v1-full",
	"@harnessy/capability-org-knowledge",
]);

export const PI_PACKAGE_NAMES = new Set([
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-orchestrator",
	"@earendil-works/pi-tui",
]);

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export const parseVersion = (version) => {
	const match = SEMVER.exec(version);
	if (match === null) throw new Error(`Harnessy release versions must be plain semver: ${version}`);
	return match.slice(1).map(Number);
};

export const nextHarnessyVersion = (current, target) => {
	const [major, minor, patch] = parseVersion(current);
	if (target === "major") return `${major + 1}.0.0`;
	if (target === "minor") return `${major}.${minor + 1}.0`;
	if (target === "patch") return `${major}.${minor}.${patch + 1}`;
	const requested = parseVersion(target);
	const currentParts = [major, minor, patch];
	for (let index = 0; index < currentParts.length; index += 1) {
		if (requested[index] > currentParts[index]) return target;
		if (requested[index] < currentParts[index]) break;
	}
	throw new Error(`Harnessy release version ${target} must be greater than ${current}`);
};

export const updateHarnessyManifest = (manifest, version) => {
	const updated = structuredClone(manifest);
	if (manifest.name === "harnessy-v2" || HARNESSY_PACKAGE_NAMES.has(manifest.name)) updated.version = version;
	for (const dependencyGroup of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
		for (const dependency of Object.keys(updated[dependencyGroup] ?? {})) {
			if (HARNESSY_PACKAGE_NAMES.has(dependency)) updated[dependencyGroup][dependency] = version;
		}
	}
	return updated;
};

const updateVersionRange = (current, version) => {
	if (current.startsWith("^")) return `^${version}`;
	if (current.startsWith("~")) return `~${version}`;
	return version;
};

export const updatePiManifest = (manifest, version) => {
	const updated = structuredClone(manifest);
	if (PI_PACKAGE_NAMES.has(manifest.name)) updated.version = version;
	for (const dependencyGroup of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
		for (const dependency of Object.keys(updated[dependencyGroup] ?? {})) {
			if (PI_PACKAGE_NAMES.has(dependency)) {
				updated[dependencyGroup][dependency] = updateVersionRange(updated[dependencyGroup][dependency], version);
			}
		}
	}
	return updated;
};
