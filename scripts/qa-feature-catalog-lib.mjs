const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const prefixOf = (id) => id.split("-")[0];

const uniqueSorted = (values) => [...new Set(values)].sort();

export const buildFeatureCatalog = ({ records, profile }) => {
	const configuredFeatures = profile.catalog?.features;
	if (!Array.isArray(configuredFeatures) || configuredFeatures.length === 0) {
		throw new Error("QA profile must declare catalog.features");
	}

	const metadataByPrefix = new Map();
	for (const feature of configuredFeatures) {
		if (typeof feature.prefix !== "string" || typeof feature.slug !== "string" || typeof feature.name !== "string") {
			throw new Error("Every catalog feature requires prefix, slug, and name strings");
		}
		if (metadataByPrefix.has(feature.prefix)) throw new Error(`Duplicate catalog prefix: ${feature.prefix}`);
		if (!SLUG_RE.test(feature.slug)) throw new Error(`Invalid catalog slug for ${feature.prefix}: ${feature.slug}`);
		metadataByPrefix.set(feature.prefix, feature);
	}

	const recordsByPrefix = new Map();
	for (const record of records) {
		const prefix = prefixOf(record.id);
		const grouped = recordsByPrefix.get(prefix) ?? [];
		grouped.push(record);
		recordsByPrefix.set(prefix, grouped);
	}

	for (const prefix of recordsByPrefix.keys()) {
		if (!metadataByPrefix.has(prefix)) throw new Error(`Missing catalog metadata for scenario prefix: ${prefix}`);
	}
	for (const prefix of metadataByPrefix.keys()) {
		if (!recordsByPrefix.has(prefix)) throw new Error(`Catalog metadata has no spec scenarios: ${prefix}`);
	}

	return {
		schemaVersion: 1,
		generatedBy: "npm run qa:catalog",
		features: [...recordsByPrefix.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([prefix, grouped]) => {
				const metadata = metadataByPrefix.get(prefix);
				return {
					slug: metadata.slug,
					name: metadata.name,
					id_prefix: prefix,
					apps: uniqueSorted(grouped.map((record) => record.app)),
					layers: uniqueSorted(grouped.map((record) => record.layer)),
					specs: uniqueSorted(grouped.map((record) => record.file)),
					scenario_count: grouped.length,
				};
			}),
	};
};

export const serializeFeatureCatalog = (catalog) => `${JSON.stringify(catalog, null, 2)}\n`;
