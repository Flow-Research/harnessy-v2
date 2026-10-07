const SEVERITY_ORDER = new Map([
	["low", 0],
	["moderate", 1],
	["high", 2],
	["critical", 3],
]);

/**
 * Reviewed exceptions for advisories that have no patched release. An exception
 * matches one advisory exactly (package, URL and vulnerable range) and lapses at
 * its expiry date, so a published fix or a lapsed review fails the audit again.
 */
export const parseAuditExceptions = (value) => {
	if (!Array.isArray(value)) throw new Error("Audit exceptions must be an array");
	return value.map((entry, index) => {
		for (const field of ["package", "url", "vulnerableVersions", "reason", "expires"]) {
			if (typeof entry?.[field] !== "string" || entry[field].trim() === "")
				throw new Error(`Audit exception ${index} requires a non-empty ${field}`);
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires) || Number.isNaN(Date.parse(`${entry.expires}T00:00:00Z`)))
			throw new Error(`Audit exception ${index} has an invalid expires date`);
		return {
			package: entry.package,
			url: entry.url,
			vulnerableVersions: entry.vulnerableVersions,
			reason: entry.reason,
			expires: entry.expires,
		};
	});
};

const exceptionApplies = (exception, finding, now) =>
	exception.package === finding.package &&
	exception.url === finding.url &&
	exception.vulnerableVersions === finding.vulnerableVersions &&
	now < Date.parse(`${exception.expires}T00:00:00Z`);

export const normalizeBunAudit = (report, threshold = "high", exceptions = [], now = Date.now()) => {
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
	for (const finding of findings) {
		if (exceptions.some((exception) => exceptionApplies(exception, finding, now))) finding.excepted = true;
	}
	const blocking = findings.filter(
		(finding) => SEVERITY_ORDER.get(finding.severity) >= thresholdRank && finding.excepted !== true,
	);
	const exceptedCount = findings.filter((finding) => finding.excepted === true).length;
	return {
		schemaVersion: 1,
		ok: blocking.length === 0,
		threshold,
		counts,
		blockingCount: blocking.length,
		exceptedCount,
		findings,
	};
};
