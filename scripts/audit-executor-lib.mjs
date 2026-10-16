const SEVERITY_ORDER = new Map([
	["low", 0],
	["moderate", 1],
	["high", 2],
	["critical", 3],
]);

export const normalizeBunAudit = (report, threshold = "high") => {
	if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("Bun audit JSON must be an object");
	const thresholdRank = SEVERITY_ORDER.get(threshold);
	if (thresholdRank === undefined) throw new Error(`Unknown audit threshold: ${threshold}`);

	const findings = [];
	for (const [packageName, advisories] of Object.entries(report)) {
		if (!Array.isArray(advisories)) throw new Error(`Bun audit entry for ${packageName} must be an array`);
		for (const advisory of advisories) {
			const severity = advisory?.severity;
			if (typeof advisory?.id !== "number" || typeof severity !== "string" || !SEVERITY_ORDER.has(severity)) {
				throw new Error(`Bun audit advisory for ${packageName} is malformed`);
			}
			findings.push({
				package: packageName,
				id: advisory.id,
				severity,
				title: typeof advisory.title === "string" ? advisory.title : "",
				url: typeof advisory.url === "string" ? advisory.url : "",
				vulnerableVersions: typeof advisory.vulnerable_versions === "string" ? advisory.vulnerable_versions : "",
			});
		}
	}
	findings.sort((left, right) => left.package.localeCompare(right.package) || left.id - right.id);

	const counts = Object.fromEntries(
		["critical", "high", "moderate", "low"].map((severity) => [
			severity,
			findings.filter((finding) => finding.severity === severity).length,
		]),
	);
	const blocking = findings.filter((finding) => SEVERITY_ORDER.get(finding.severity) >= thresholdRank);
	return { schemaVersion: 1, ok: blocking.length === 0, threshold, counts, blockingCount: blocking.length, findings };
};
