import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { parse, printParseErrorCode } from "jsonc-parser";

export const EVIDENCE_SCHEMA_VERSION = 1;
export const NORMALIZED_TIMESTAMP = "1970-01-01T00:00:00.000Z";
export const MAX_EVIDENCE_BYTES = 512 * 1024;
export const EVIDENCE_MARKER = ".harnessy-supply-chain-evidence";
export const CANONICAL_EVIDENCE_DIRECTORY = ".supply-chain-evidence";
export const REPRO_EVIDENCE_PARENT = ".supply-chain-repro";
export const APPROVED_HARNESSY_LICENSE = "AGPL-3.0-only";

export const sha256 = (value) =>
	createHash("sha256")
		.update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
		.digest("hex");

const sortObject = (value) => {
	if (Array.isArray(value)) return value.map(sortObject);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
};

export const canonicalJson = (value) => `${JSON.stringify(sortObject(value), undefined, 2)}\n`;

export const assertEvidenceInventoriesMatch = (inventories) => {
	if (!Array.isArray(inventories) || inventories.length < 2) {
		throw new Error("Reproducibility requires at least two evidence inventories");
	}
	const baseline = canonicalJson(inventories[0].files);
	const mismatches = inventories.slice(1).filter((inventory) => canonicalJson(inventory.files) !== baseline);
	if (mismatches.length > 0) {
		throw new Error(
			`Supply-chain evidence inventory differs: ${inventories[0].label} != ${mismatches.map((inventory) => inventory.label).join(", ")}`,
		);
	}
};

const componentKey = (component) =>
	`${String(component.purl ?? "")}\u0000${String(component.name ?? "")}\u0000${String(component.version ?? "")}\u0000${String(component["bom-ref"] ?? "")}`;

const sortCycloneDx = (document) => {
	const sorted = sortObject(document);
	if (Array.isArray(sorted.components)) sorted.components.sort((left, right) => componentKey(left).localeCompare(componentKey(right)));
	if (Array.isArray(sorted.dependencies)) {
		for (const dependency of sorted.dependencies) {
			if (Array.isArray(dependency.dependsOn)) dependency.dependsOn.sort();
		}
		sorted.dependencies.sort((left, right) => String(left.ref).localeCompare(String(right.ref)));
	}
	for (const component of sorted.components ?? []) {
		for (const key of ["externalReferences", "hashes", "licenses", "properties"]) {
			if (Array.isArray(component[key])) component[key].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
		}
	}
	return sorted;
};

const uuidFromHash = (hash) => {
	const bytes = Buffer.from(hash.slice(0, 32), "hex");
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const normalizeCycloneDx = (input, graphName) => {
	if (input?.bomFormat !== "CycloneDX" || !Array.isArray(input.components) || !Array.isArray(input.dependencies)) {
		throw new Error(`${graphName} is not a complete CycloneDX component/dependency graph`);
	}
	const document = structuredClone(input);
	document.metadata = { ...(document.metadata ?? {}), timestamp: NORMALIZED_TIMESTAMP };
	document.serialNumber = "urn:uuid:00000000-0000-4000-8000-000000000000";
	const stable = sortCycloneDx(document);
	stable.serialNumber = `urn:uuid:${uuidFromHash(sha256(canonicalJson(stable)))}`;
	return sortCycloneDx(stable);
};

export const parseBunLock = (source) => {
	if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 64 * 1024 * 1024) {
		throw new Error("Bun lockfile is missing or oversized");
	}
	const errors = [];
	const lock = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
	if (errors.length > 0) {
		throw new Error(`Malformed Bun lockfile: ${errors.map((error) => printParseErrorCode(error.error)).join(", ")}`);
	}
	if (lock?.lockfileVersion !== 1 || lock.packages === null || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
		throw new Error("Unsupported Bun lockfile structure");
	}
	return lock;
};

export const parseNpmLock = (source, label = "package-lock.json") => {
	if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 128 * 1024 * 1024) {
		throw new Error(`${label} is missing or oversized`);
	}
	let lock;
	try {
		lock = JSON.parse(source);
	} catch (error) {
		throw new Error(`Malformed npm lockfile: ${label}`, { cause: error });
	}
	if (lock?.lockfileVersion !== 3 || lock.packages === null || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
		throw new Error(`${label} is not a supported npm lockfile`);
	}
	return lock;
};

const npmPackageNameFromPath = (path) => {
	const parts = path.split("/");
	const nodeModules = parts.lastIndexOf("node_modules");
	if (nodeModules < 0 || nodeModules === parts.length - 1) return null;
	if (parts[nodeModules + 1].startsWith("@")) {
		return parts.length > nodeModules + 2 ? `${parts[nodeModules + 1]}/${parts[nodeModules + 2]}` : null;
	}
	return parts[nodeModules + 1];
};

const npmPlatformMatches = (constraint, value) => {
	if (!Array.isArray(constraint) || constraint.length === 0) return true;
	if (constraint.includes(`!${value}`)) return false;
	const positive = constraint.filter((entry) => typeof entry === "string" && !entry.startsWith("!"));
	return positive.length === 0 || positive.includes(value);
};

const npmDependencyPath = ({ availablePaths, parentPath, dependencyName }) => {
	let ancestor = parentPath;
	while (true) {
		const candidate = ancestor === "" ? `node_modules/${dependencyName}` : `${ancestor}/node_modules/${dependencyName}`;
		if (availablePaths.has(candidate)) return candidate;
		if (ancestor === "") return null;
		const nestedMarker = ancestor.lastIndexOf("/node_modules/");
		if (nestedMarker >= 0) ancestor = ancestor.slice(0, nestedMarker);
		else ancestor = "";
	}
};

export const npmLockToCycloneDx = (
	lock,
	licenseByPackage = new Map(),
	{ platform = process.platform, arch = process.arch } = {},
) => {
	const root = lock.packages?.[""];
	if (root === null || typeof root !== "object" || typeof root.name !== "string" || typeof root.version !== "string") {
		throw new Error("npm lockfile root package is missing name or version");
	}
	const entries = Object.entries(lock.packages)
		.filter(
			([path, metadata]) =>
				path.includes("node_modules/") &&
				metadata !== null &&
				typeof metadata === "object" &&
				metadata.link !== true &&
				metadata.dev !== true &&
				typeof metadata.version === "string" &&
				npmPlatformMatches(metadata.os, platform) &&
				npmPlatformMatches(metadata.cpu, arch),
		)
		.sort(([left], [right]) => left.localeCompare(right));
	const availablePaths = new Set(entries.map(([path]) => path));
	const refByPath = new Map(entries.map(([path]) => [path, `npm-lock:${encodeURIComponent(path)}`]));
	const components = entries.map(([path, metadata]) => {
		const name = metadata.name ?? npmPackageNameFromPath(path);
		if (typeof name !== "string" || name.length === 0) throw new Error(`npm lock entry has no package name: ${path}`);
		const declaredLicense = licenseByPackage.get(`${name}@${metadata.version}`) ?? metadata.license ?? "NOASSERTION";
		return {
			"bom-ref": refByPath.get(path),
			type: "library",
			name,
			version: metadata.version,
			purl: npmPurl(name, metadata.version),
			licenses: [{ license: declaredLicense === "NOASSERTION" ? { name: "NOASSERTION" } : { name: declaredLicense } }],
			properties: [
				{ name: "harnessy:npm:lock-path", value: path },
				...(typeof metadata.integrity === "string"
					? [{ name: "harnessy:npm:integrity", value: metadata.integrity }]
					: []),
			],
		};
	});
	const dependencyRow = (path, metadata) => {
		const optionalNames = new Set([
			...Object.keys(metadata.optionalDependencies ?? {}),
			...Object.entries(metadata.peerDependenciesMeta ?? {})
				.filter(([, value]) => value?.optional === true)
				.map(([name]) => name),
		]);
		const dependencyNames = [
			...new Set([
				...Object.keys(metadata.dependencies ?? {}),
				...Object.keys(metadata.optionalDependencies ?? {}),
				...Object.keys(metadata.peerDependencies ?? {}),
			]),
		].sort();
		const dependsOn = [];
		for (const dependencyName of dependencyNames) {
			const targetPath = npmDependencyPath({ availablePaths, parentPath: path, dependencyName });
			if (targetPath === null) {
				if (optionalNames.has(dependencyName)) continue;
				throw new Error(`npm dependency ${dependencyName} from ${path || "lock root"} has no exact production lock entry`);
			}
			dependsOn.push(refByPath.get(targetPath));
		}
		return { ref: path === "" ? "npm-lock:." : refByPath.get(path), dependsOn };
	};
	const dependencies = entries.map(([path, metadata]) => dependencyRow(path, metadata));
	dependencies.push(dependencyRow("", root));
	return normalizeCycloneDx(
		{
			bomFormat: "CycloneDX",
			specVersion: "1.5",
			version: 1,
			metadata: {
				component: {
					"bom-ref": "npm-lock:.",
					type: "application",
					name: root.name,
					version: root.version,
					purl: npmPurl(root.name, root.version),
				},
			},
			components,
			dependencies,
		},
		"npm-production-lock",
	);
};

export const reconcileNpmCycloneDxWithLock = (npmGraph, lockGraph) => {
	const normalizedNpm = normalizeCycloneDx(npmGraph, "npm-production-base");
	const npmByIdentity = new Map();
	for (const component of normalizedNpm.components) {
		const identity = `${component.name}\0${component.version}`;
		const candidates = npmByIdentity.get(identity) ?? [];
		candidates.push(component);
		npmByIdentity.set(identity, candidates);
	}
	for (const candidates of npmByIdentity.values()) {
		candidates.sort((left, right) => String(left["bom-ref"]).localeCompare(String(right["bom-ref"])));
	}
	const components = lockGraph.components.map((lockComponent) => {
		const npmComponent = npmByIdentity.get(`${lockComponent.name}\0${lockComponent.version}`)?.[0];
		const properties = [...(npmComponent?.properties ?? []), ...(lockComponent.properties ?? [])];
		return {
			...(npmComponent ?? {}),
			...lockComponent,
			properties: [...new Map(properties.map((property) => [canonicalJson(property), property])).values()],
		};
	});
	const rootProperties = [
		...(normalizedNpm.metadata?.component?.properties ?? []),
		...(lockGraph.metadata?.component?.properties ?? []),
	];
	return normalizeCycloneDx(
		{
			bomFormat: "CycloneDX",
			specVersion: "1.5",
			version: 1,
			metadata: {
				...normalizedNpm.metadata,
				component: {
					...normalizedNpm.metadata?.component,
					...lockGraph.metadata?.component,
					properties: [...new Map(rootProperties.map((property) => [canonicalJson(property), property])).values()],
				},
				properties: [
					...(normalizedNpm.metadata?.properties ?? []),
					{ name: "harnessy:npm:base-sbom-sha256", value: sha256(canonicalJson(normalizedNpm)) },
					{ name: "harnessy:npm:base-component-count", value: String(normalizedNpm.components.length) },
					{ name: "harnessy:npm:lock-component-count", value: String(lockGraph.components.length) },
				],
			},
			components,
			dependencies: lockGraph.dependencies,
		},
		"root-production",
	);
};

const nameVersionFromResolution = (resolution) => {
	if (typeof resolution !== "string") throw new Error("Bun package resolution is not a string");
	const separator = resolution.lastIndexOf("@");
	if (separator < 1 || separator === resolution.length - 1) throw new Error(`Malformed Bun package resolution: ${resolution}`);
	return { name: resolution.slice(0, separator), version: resolution.slice(separator + 1) };
};

const npmPurl = (name, version) => {
	if (!name.startsWith("@")) return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
	const slash = name.indexOf("/");
	if (slash < 2 || slash === name.length - 1) throw new Error(`Malformed scoped npm package name: ${name}`);
	return `pkg:npm/${encodeURIComponent(name.slice(0, slash))}/${encodeURIComponent(name.slice(slash + 1))}@${encodeURIComponent(version)}`;
};

const dependencyNames = (metadata, fullWorkspace = false) => {
	if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return [];
	const fields = fullWorkspace
		? ["dependencies", "devDependencies", "optionalDependencies"]
		: ["dependencies", "optionalDependencies"];
	return [...new Set(fields.flatMap((field) => Object.keys(metadata[field] ?? {})))].sort();
};

const resolvePackageKey = ({ packageKeys, parentKey, dependencyName }) => {
	const suffix = `/${dependencyName}`;
	const candidates = packageKeys
		.filter((key) => {
			if (key === dependencyName) return true;
			if (!key.endsWith(suffix)) return false;
			const ancestor = key.slice(0, -suffix.length);
			return parentKey === ancestor || parentKey.startsWith(`${ancestor}/`);
		})
		.sort((left, right) => right.length - left.length || left.localeCompare(right));
	return candidates[0] ?? null;
};

export const bunLockToCycloneDx = (lock, licenseByPackage = new Map(), workspaceVersionByName = new Map()) => {
	const packageEntries = Object.entries(lock.packages);
	const packageKeys = packageEntries.map(([key]) => key);
	const workspaceEntries = Object.entries(lock.workspaces ?? {});
	if (workspaceEntries.length === 0) throw new Error("Bun lockfile has no workspace metadata");
	const workspaceRefByName = new Map();
	const workspaceRefByPath = new Map();
	const workspaceRows = workspaceEntries.map(([path, metadata]) => {
		if (metadata === null || typeof metadata !== "object" || typeof metadata.name !== "string") {
			throw new Error(`Malformed Bun workspace record: ${path || "."}`);
		}
		const version = metadata.version ?? workspaceVersionByName.get(metadata.name);
		if (typeof version !== "string" || version.length === 0) {
			throw new Error(`Bun workspace ${metadata.name} is missing its manifest version`);
		}
		const ref = `bun-workspace:${path === "" ? "." : encodeURIComponent(path)}`;
		workspaceRefByName.set(metadata.name, ref);
		workspaceRefByPath.set(path, ref);
		return { path, metadata, name: metadata.name, version, ref };
	});
	const workspaceRefByPackageKey = new Map();
	for (const [key, entry] of packageEntries) {
		if (!Array.isArray(entry) || entry.length === 0) throw new Error(`Malformed Bun package record: ${key}`);
		const resolution = entry[0];
		if (typeof resolution !== "string") throw new Error(`Malformed Bun package resolution: ${key}`);
		const workspaceMarker = resolution.lastIndexOf("@workspace:");
		if (workspaceMarker > 0) {
			const workspacePath = resolution.slice(workspaceMarker + "@workspace:".length);
			const ref = workspaceRefByPath.get(workspacePath);
			if (ref === undefined) throw new Error(`Bun package ${key} targets unknown workspace ${workspacePath}`);
			workspaceRefByPackageKey.set(key, ref);
		}
	}
	const refForDependency = (parentKey, dependencyName) => {
		const workspaceRef = workspaceRefByName.get(dependencyName);
		if (workspaceRef !== undefined) return workspaceRef;
		const key = resolvePackageKey({ packageKeys, parentKey, dependencyName });
		if (key === null) throw new Error(`Bun dependency ${dependencyName} from ${parentKey || "workspace root"} has no exact lock entry`);
		return workspaceRefByPackageKey.get(key) ?? `bun-lock:${encodeURIComponent(key)}`;
	};
	const components = [];
	const dependencies = [];
	for (const row of workspaceRows) {
		const component = {
			"bom-ref": row.ref,
			type: row.path === "" ? "application" : "library",
			name: row.name,
			version: row.version,
			purl: npmPurl(row.name, row.version),
			licenses: [
				{
					license:
						licenseByPackage.get(`${row.name}@${row.version}`) === undefined
							? { name: "NOASSERTION" }
							: { name: licenseByPackage.get(`${row.name}@${row.version}`) },
				},
			],
			properties: [{ name: "harnessy:bun:workspace-path", value: row.path || "." }],
		};
		if (row.path !== "") components.push(component);
		dependencies.push({
			ref: row.ref,
			dependsOn: dependencyNames(row.metadata, true).map((name) => refForDependency(row.name, name)),
		});
	}
	for (const [key, entry] of packageEntries) {
		if (workspaceRefByPackageKey.has(key)) continue;
		const { name, version } = nameVersionFromResolution(entry[0]);
		const ref = `bun-lock:${encodeURIComponent(key)}`;
		const integrity = typeof entry[3] === "string" ? entry[3] : null;
		const declaredLicense = licenseByPackage.get(`${name}@${version}`) ?? "NOASSERTION";
		components.push({
			"bom-ref": ref,
			type: "library",
			name,
			version,
			purl: npmPurl(name, version),
			licenses: [{ license: declaredLicense === "NOASSERTION" ? { name: "NOASSERTION" } : { name: declaredLicense } }],
			properties: [
				{ name: "harnessy:bun:lock-key", value: key },
				...(integrity === null ? [] : [{ name: "harnessy:bun:integrity", value: integrity }]),
			],
		});
		dependencies.push({
			ref,
			dependsOn: dependencyNames(entry[2]).map((dependencyName) => refForDependency(key, dependencyName)),
		});
	}
	const rootWorkspace = workspaceRows.find((row) => row.path === "");
	if (rootWorkspace === undefined) throw new Error("Bun lockfile has no root workspace");
	return normalizeCycloneDx(
		{
			bomFormat: "CycloneDX",
			specVersion: "1.5",
			version: 1,
			metadata: {
				component: {
					"bom-ref": rootWorkspace.ref,
					type: "application",
					name: rootWorkspace.name,
					version: rootWorkspace.version,
					purl: npmPurl(rootWorkspace.name, rootWorkspace.version),
				},
			},
			components,
			dependencies,
		},
		"executor-full",
	);
};

export const buildPackedConsumerEvidence = ({
	rootGraph,
	artifacts,
	descriptors,
	consumerDescriptorKeys,
	rootLockSha256,
}) => {
	const descriptorByKey = new Map(descriptors.map((descriptor) => [descriptor.key ?? descriptor.name, descriptor]));
	const artifactByKey = new Map(artifacts.map((artifact) => [artifact.key, artifact]));
	const selectedArtifacts = consumerDescriptorKeys.map((key) => {
		const artifact = artifactByKey.get(key);
		if (artifact === undefined) throw new Error(`Packed consumer has no attested artifact for ${key}`);
		return artifact;
	});
	const allArtifactKeyByInstallName = new Map(
		descriptors.map((descriptor) => [descriptor.installName ?? descriptor.name, descriptor.key ?? descriptor.name]),
	);
	const artifactRefByInstallName = new Map();
	const artifactComponents = selectedArtifacts.map((artifact) => {
		const descriptor = descriptorByKey.get(artifact.key);
		if (descriptor === undefined) throw new Error(`Packed consumer has no descriptor for ${artifact.key}`);
		const installName = descriptor.installName ?? descriptor.name;
		const ref = `packed-artifact:${encodeURIComponent(artifact.key)}`;
		if (artifactRefByInstallName.has(installName)) throw new Error(`Packed consumer has duplicate install name ${installName}`);
		artifactRefByInstallName.set(installName, ref);
		return {
			"bom-ref": ref,
			type: "library",
			name: installName,
			version: artifact.version,
			purl: npmPurl(installName, artifact.version),
			licenses: [
				{
					license:
						artifact.license.declaredLicense === "NOASSERTION"
							? { name: "NOASSERTION" }
							: { name: artifact.license.declaredLicense },
				},
			],
			properties: [
				{ name: "harnessy:artifact:key", value: artifact.key },
				{ name: "harnessy:artifact:sha256", value: artifact.sha256 },
				{ name: "harnessy:artifact:integrity", value: artifact.integrity },
			],
		};
	});
	const rootComponentsByName = new Map();
	for (const component of rootGraph.components) {
		const rows = rootComponentsByName.get(component.name) ?? [];
		rows.push(component);
		rootComponentsByName.set(component.name, rows);
	}
	const rootComponentByRef = new Map(rootGraph.components.map((component) => [component["bom-ref"], component]));
	const rootDependencyByRef = new Map(rootGraph.dependencies.map((dependency) => [dependency.ref, dependency]));
	const initialRootRefs = new Set();
	const resolveDependencyRef = (artifact, name, declaredVersion, optional) => {
		const artifactRef = artifactRefByInstallName.get(name);
		if (artifactRef !== undefined) return artifactRef;
		if (allArtifactKeyByInstallName.has(name)) {
			if (optional) return null;
			throw new Error(`Packed artifact ${artifact.key} requires unselected release artifact ${name}`);
		}
		const candidates = rootComponentsByName.get(name) ?? [];
		const exact = candidates.filter((component) => component.version === declaredVersion);
		if (exact.length === 1) {
			initialRootRefs.add(exact[0]["bom-ref"]);
			return exact[0]["bom-ref"];
		}
		if (exact.length === 0 && candidates.length === 1) {
			initialRootRefs.add(candidates[0]["bom-ref"]);
			return candidates[0]["bom-ref"];
		}
		throw new Error(
			`Packed artifact ${artifact.key} dependency ${name}@${declaredVersion} has ${exact.length || candidates.length} root-lock candidates`,
		);
	};
	const artifactDependencies = selectedArtifacts.map((artifact) => {
		const required = Object.entries(artifact.manifestDependencies ?? {}).map(([name, version]) =>
			resolveDependencyRef(artifact, name, version, false),
		);
		const optional = Object.entries(artifact.manifestOptionalDependencies ?? {})
			.map(([name, version]) => resolveDependencyRef(artifact, name, version, true))
			.filter((ref) => ref !== null);
		return {
			ref: `packed-artifact:${encodeURIComponent(artifact.key)}`,
			dependsOn: [...required, ...optional],
		};
	});
	const reachableRootRefs = new Set();
	const queue = [...initialRootRefs];
	while (queue.length > 0) {
		const ref = queue.shift();
		if (reachableRootRefs.has(ref)) continue;
		if (!rootComponentByRef.has(ref)) throw new Error(`Packed consumer root closure contains dangling component ${ref}`);
		reachableRootRefs.add(ref);
		for (const target of rootDependencyByRef.get(ref)?.dependsOn ?? []) {
			if (!rootComponentByRef.has(target)) throw new Error(`Packed consumer root closure contains dangling dependency ${target}`);
			queue.push(target);
		}
	}
	const reachableRootComponents = rootGraph.components.filter((component) => reachableRootRefs.has(component["bom-ref"]));
	const reachableRootDependencies = rootGraph.dependencies.filter((dependency) => reachableRootRefs.has(dependency.ref));
	const rootRef = "packed-consumer-root";
	const rootDependsOn = consumerDescriptorKeys.map((key) => {
		if (!descriptorByKey.has(key)) throw new Error(`Packed consumer root references unknown descriptor ${key}`);
		return `packed-artifact:${encodeURIComponent(key)}`;
	});
	const graph = normalizeCycloneDx(
		{
			bomFormat: "CycloneDX",
			specVersion: "1.5",
			version: 1,
			metadata: {
				component: { "bom-ref": rootRef, type: "application", name: "harnessy-packed-consumer", version: "1" },
			},
			components: [...reachableRootComponents, ...artifactComponents],
			dependencies: [...reachableRootDependencies, ...artifactDependencies, { ref: rootRef, dependsOn: rootDependsOn }],
		},
		"packed-consumer",
	);
	const graphIssues = validateCycloneDxReferences(graph, "packed-consumer");
	if (graphIssues.length > 0) throw new Error(`Packed consumer graph failed: ${graphIssues.join("; ")}`);
	const lock = {
		schemaVersion: EVIDENCE_SCHEMA_VERSION,
		resolution: "offline-root-lock-and-local-tarballs",
		rootProductionLockSha256: rootLockSha256,
		consumerDescriptorKeys: [...consumerDescriptorKeys].sort(),
		artifacts: selectedArtifacts
			.map((artifact) => ({
				key: artifact.key,
				version: artifact.version,
				sha256: artifact.sha256,
				integrity: artifact.integrity,
				dependencies: sortObject(artifact.manifestDependencies ?? {}),
				optionalDependencies: sortObject(artifact.manifestOptionalDependencies ?? {}),
			}))
			.sort((left, right) => left.key.localeCompare(right.key)),
	};
	return { graph, lock };
};

export const validateCycloneDxReferences = (graph, label) => {
	const componentRefs = new Set((graph.components ?? []).map((component) => component["bom-ref"]));
	const rootRef = graph.metadata?.component?.["bom-ref"];
	if (typeof rootRef === "string") componentRefs.add(rootRef);
	const issues = [];
	const dependencyRefs = new Set();
	for (const dependency of graph.dependencies ?? []) {
		if (dependencyRefs.has(dependency.ref)) issues.push(`${label} has duplicate dependency row ${dependency.ref}`);
		dependencyRefs.add(dependency.ref);
		if (!componentRefs.has(dependency.ref)) issues.push(`${label} has dangling dependency row ${dependency.ref}`);
		for (const target of dependency.dependsOn ?? []) {
			if (!componentRefs.has(target)) issues.push(`${label} has dangling dependency target ${target}`);
		}
	}
	if (componentRefs.size !== (graph.components?.length ?? 0) + (typeof rootRef === "string" ? 1 : 0)) {
		issues.push(`${label} has duplicate component bom-ref values`);
	}
	return issues;
};

const validateRelativePath = (path) => {
	if (typeof path !== "string" || path.length === 0 || path.length > 4_096 || path.includes("\0") || isAbsolute(path)) {
		throw new Error(`Unsafe evidence path: ${String(path)}`);
	}
	const normalized = path.replaceAll("\\", "/");
	if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
		throw new Error(`Unsafe evidence path: ${path}`);
	}
	return normalized;
};

export const collectRepositoryInputPaths = ({
	repoRoot,
	relativeRoot,
	excludedDirectories = [".git", ".local", ".turbo", "coverage", "dist", "node_modules"],
	maxFiles = 5_000,
	maxBytes = 512 * 1024 * 1024,
}) => {
	const normalizedRoot = validateRelativePath(relativeRoot);
	const absoluteRoot = resolve(repoRoot, normalizedRoot);
	const rootStat = lstatSync(absoluteRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error(`Repository input root is not a regular directory: ${relativeRoot}`);
	}
	const excluded = new Set(excludedDirectories);
	const paths = [];
	let totalBytes = 0;
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
			const absolute = resolve(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Repository build input must not be a symlink: ${relative(repoRoot, absolute)}`);
			if (entry.isDirectory()) {
				if (!excluded.has(entry.name)) visit(absolute);
				continue;
			}
			if (!entry.isFile()) throw new Error(`Repository build input is not a regular file: ${relative(repoRoot, absolute)}`);
			const stat = lstatSync(absolute);
			totalBytes += stat.size;
			paths.push(validateRelativePath(relative(repoRoot, absolute).replaceAll("\\", "/")));
			if (paths.length > maxFiles || totalBytes > maxBytes) {
				throw new Error(`Repository build input set is unexpectedly large: ${relativeRoot}`);
			}
		}
	};
	visit(absoluteRoot);
	return paths.sort();
};

export const assertSafeEvidenceOutput = ({ repoRoot, outputRoot, generating }) => {
	const canonicalRepo = resolve(repoRoot);
	const resolvedOutput = resolve(outputRoot);
	if (resolvedOutput === canonicalRepo || !resolvedOutput.startsWith(`${canonicalRepo}${sep}`)) {
		throw new Error("Supply-chain output must be inside the repository worktree");
	}
	const relativeOutput = relative(canonicalRepo, resolvedOutput).replaceAll("\\", "/");
	const parts = relativeOutput.split("/");
	const allowed =
		relativeOutput === CANONICAL_EVIDENCE_DIRECTORY ||
		(parts.length === 2 && parts[0] === REPRO_EVIDENCE_PARENT && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(parts[1]));
	if (!allowed) {
		throw new Error(
			`Supply-chain output must be ${CANONICAL_EVIDENCE_DIRECTORY} or ${REPRO_EVIDENCE_PARENT}/<run>`,
		);
	}
	let current = canonicalRepo;
	for (const part of parts) {
		current = resolve(current, part);
		if (!existsSync(current)) break;
		if (lstatSync(current).isSymbolicLink()) throw new Error("Supply-chain output path must not contain a symlink");
	}
	if (!existsSync(resolvedOutput)) return;
	if (lstatSync(resolvedOutput).isSymbolicLink() || !lstatSync(resolvedOutput).isDirectory()) {
		throw new Error("Supply-chain output must be a non-symlink directory");
	}
	if (generating) {
		const markerPath = resolve(resolvedOutput, EVIDENCE_MARKER);
		if (!existsSync(markerPath) || lstatSync(markerPath).isSymbolicLink()) {
			throw new Error(`Refusing to replace unmarked output directory: ${relativeOutput}`);
		}
		const marker = readFileSync(markerPath, "utf8");
		if (marker !== `schema=${EVIDENCE_SCHEMA_VERSION}\n`) {
			throw new Error(`Refusing to replace output directory with an invalid marker: ${relativeOutput}`);
		}
	}
};

export const readSafeEvidence = (root, path, maxBytes = MAX_EVIDENCE_BYTES) => {
	const normalized = validateRelativePath(path);
	const canonicalRoot = realpathSync(root);
	let current = canonicalRoot;
	for (const part of normalized.split("/")) {
		current = resolve(current, part);
		const stat = lstatSync(current);
		if (stat.isSymbolicLink()) throw new Error(`Evidence path must not contain a symlink: ${path}`);
	}
	const canonical = realpathSync(current);
	if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
		throw new Error(`Evidence path escaped its root: ${path}`);
	}
	const stat = lstatSync(canonical);
	if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Evidence file is missing, not regular, or oversized: ${path}`);
	return readFileSync(canonical);
};

export const resolveLicenseDeclaration = ({ packageRoot, declaration }) => {
	if (typeof declaration !== "string" || declaration.trim() === "") {
		return { declaredLicense: "NOASSERTION", sourcePath: null, text: null };
	}
	const seeLicense = /^SEE LICENSE IN (.+)$/iu.exec(declaration.trim());
	if (seeLicense === null) return { declaredLicense: declaration.trim(), sourcePath: null, text: null };
	const sourcePath = seeLicense[1].trim();
	const text = readSafeEvidence(packageRoot, sourcePath).toString("utf8");
	return { declaredLicense: declaration.trim(), sourcePath, text };
};

export const validateComponentEvidence = ({ graph, scope, evidenceByPackage }) => {
	const issues = [];
	for (const component of graph.components ?? []) {
		const key = `${component.name}@${component.version}`;
		const evidence = evidenceByPackage.get(key);
		if (evidence === undefined) {
			issues.push(`${scope}:${component.purl ?? key} has no installed package metadata evidence`);
			continue;
		}
		if (evidence.declaredLicense === "NOASSERTION") {
			issues.push(`${scope}:${component.purl ?? key} has no declared license`);
		}
		if (evidence.requiredLicenseFile !== null && evidence.evidence === null) {
			issues.push(
				`${scope}:${component.purl ?? key} declares SEE LICENSE IN ${evidence.requiredLicenseFile}, but the target is missing or unsafe`,
			);
		}
	}
	return issues;
};

export const classifyArtifactLicense = ({
	descriptor,
	manifest,
	packedPaths,
	packageRootLicense,
	harnessyLicense,
	piLicense,
	executorLicense,
	claudeBridgeNotice,
	claudeBridgeLicense,
}) => {
	const issues = [];
	const provenance = descriptor.provenance ?? "harnessy-authored";
	const rootLicensePresent = packedPaths.includes("LICENSE") && packageRootLicense !== null;
	if (provenance === "inherited-pi") {
		if (manifest.license !== "MIT") issues.push("inherited Pi package must declare MIT");
		if (!rootLicensePresent) issues.push("inherited Pi package is missing package-root LICENSE");
		else if (!packageRootLicense.equals(piLicense)) issues.push("inherited Pi LICENSE differs from the canonical Pi notice");
	}
	if (provenance === "inherited-executor") {
		if (manifest.license !== "MIT") issues.push("inherited Executor package must declare MIT");
		if (!rootLicensePresent) issues.push("inherited Executor package is missing package-root LICENSE");
		else if (!packageRootLicense.equals(executorLicense)) issues.push("inherited Executor LICENSE differs from the vendor notice");
	}
	if (descriptor.name === "@harnessy/core") {
		if (!packedPaths.includes("CLAUDE_BRIDGE_VENDOR.md") || !packedPaths.includes("THIRD_PARTY_LICENSES/pi-claude-bridge.txt")) {
			issues.push("Core tarball is missing the Claude bridge vendoring notice or license");
		}
		if (claudeBridgeNotice === null || claudeBridgeLicense === null) issues.push("Claude bridge evidence is unreadable");
	}
	if (provenance === "harnessy-authored") {
		if (manifest.license !== APPROVED_HARNESSY_LICENSE) {
			issues.push(`Harnessy package must declare the approved ${APPROVED_HARNESSY_LICENSE} policy`);
		}
		if (!rootLicensePresent) issues.push("Harnessy package is missing package-root LICENSE evidence");
		else if (harnessyLicense === undefined || harnessyLicense === null) issues.push("canonical Harnessy AGPL notice is unavailable");
		else if (!packageRootLicense.equals(harnessyLicense)) issues.push("Harnessy LICENSE differs from the canonical AGPL notice");
	}
	const policySatisfied =
		provenance !== "harnessy-authored" ||
		(manifest.license === APPROVED_HARNESSY_LICENSE && rootLicensePresent);
	return {
		provenance,
		declaredLicense: typeof manifest.license === "string" ? manifest.license : "NOASSERTION",
		rootLicensePresent,
		rootLicenseSha256: packageRootLicense === null ? null : sha256(packageRootLicense),
		decisionRequired: !policySatisfied,
		issues,
	};
};

const licenseNames = (component) => {
	const values = (component.licenses ?? []).flatMap((entry) => {
		if (typeof entry.expression === "string") return [entry.expression];
		if (typeof entry.license?.id === "string") return [entry.license.id];
		if (typeof entry.license?.name === "string") return [entry.license.name];
		return [];
	});
	return values.length === 0 ? ["NOASSERTION"] : [...new Set(values)].sort();
};

export const makeLicenseReport = ({ graphs, artifacts, licenseTexts, componentEvidence = new Map(), componentIssues = [] }) => {
	const components = [];
	for (const [scope, graph] of Object.entries(graphs)) {
		for (const component of graph.components ?? []) {
			const evidence = componentEvidence.get(`${scope}\0${component["bom-ref"]}`) ?? null;
			components.push({
				scope,
				bomRef: component["bom-ref"],
				purl: component.purl ?? null,
				name: component.name,
				version: component.version ?? null,
				declaredLicenses: licenseNames(component),
				evidenceSourcePath: evidence?.sourcePath ?? null,
				evidenceSha256: evidence?.sha256 ?? null,
				licenseTextFile: evidence === null ? null : `license-texts/${evidence.sha256}.txt`,
			});
		}
	}
	return {
		schemaVersion: EVIDENCE_SCHEMA_VERSION,
		legalDecision: `V2D-002 approved: Harnessy-authored packages use ${APPROVED_HARNESSY_LICENSE}; inherited and third-party boundaries remain under their own terms`,
		summary: {
			componentCount: components.length,
			artifactCount: artifacts.length,
			noAssertionCount: components.filter((component) => component.declaredLicenses.includes("NOASSERTION")).length,
			decisionRequiredCount: artifacts.filter((artifact) => artifact.license.decisionRequired).length,
		},
		components: components.sort((left, right) => `${left.scope}\0${left.purl ?? left.name}`.localeCompare(`${right.scope}\0${right.purl ?? right.name}`)),
		artifacts: [...artifacts].sort((left, right) => left.key.localeCompare(right.key)),
		licenseTexts: [...licenseTexts].sort((left, right) => left.sha256.localeCompare(right.sha256)),
		issues: [...new Set(componentIssues)].sort(),
	};
};

export const licensesMarkdown = (report) => {
	const lines = [
		"# Harnessy supply-chain license evidence",
		"",
		report.legalDecision,
		"",
		`Components: ${report.summary.componentCount}; artifacts: ${report.summary.artifactCount}; NOASSERTION: ${report.summary.noAssertionCount}; legal decisions required: ${report.summary.decisionRequiredCount}.`,
		"",
		"## Release artifacts",
		"",
		"| Artifact | Provenance | Declared license | Package-root evidence | Decision required |",
		"|---|---|---|---|---|",
	];
	for (const artifact of report.artifacts) {
		lines.push(`| ${artifact.key} | ${artifact.license.provenance} | ${artifact.license.declaredLicense} | ${artifact.license.rootLicenseSha256 ?? "missing"} | ${artifact.license.decisionRequired ? "yes" : "no"} |`);
	}
	lines.push("", "## Dependency components", "", "| Scope | Package | Version | Declared license |", "|---|---|---|---|");
	for (const component of report.components) {
		lines.push(`| ${component.scope} | ${component.purl ?? component.name} | ${component.version ?? ""} | ${component.declaredLicenses.join(" OR ")} |`);
	}
	if (report.nestedV1License !== undefined) {
		lines.push(
			"",
			"## Embedded V1 source license",
			"",
			`The nested license at \`${report.nestedV1License.sourcePath}\` has SHA-256 \`${report.nestedV1License.sha256}\`. It applies to the embedded V1 source and does **not** license the outer Harnessy package.`,
		);
	}
	if ((report.issues ?? []).length > 0) lines.push("", "## Evidence issues", "", ...report.issues.map((issue) => `- ${issue}`));
	return `${lines.join("\n")}\n`;
};

export const strictLicenseIssues = (report) => [
	...(report.issues ?? []),
	...report.components
		.filter((component) => component.declaredLicenses.includes("NOASSERTION"))
		.map((component) => `${component.scope}:${component.purl ?? component.name} has NOASSERTION`),
	...report.artifacts
		.filter((artifact) => artifact.license.decisionRequired)
		.map((artifact) => `${artifact.key} does not satisfy the approved V2D-002 license policy`),
	...report.artifacts.flatMap((artifact) => artifact.license.issues.map((issue) => `${artifact.key}: ${issue}`)),
	...report.artifacts.flatMap((artifact) =>
		(artifact.releaseBlockers ?? []).map((issue) => `${artifact.key}: ${issue}`),
	),
];

export const releaseToolchainIssues = ({ node, nodeReleasePin, npm, npmReleasePin, bun, bunReleasePin, python, pythonReleaseSeries }) => {
	const issues = [];
	if (node?.replace(/^v/u, "") !== nodeReleasePin?.replace(/^v/u, "")) {
		issues.push(`Node ${node} does not match the release evidence pin ${nodeReleasePin}`);
	}
	if (npm !== npmReleasePin) issues.push(`npm ${npm} does not match the release evidence pin ${npmReleasePin}`);
	if (bun !== bunReleasePin) issues.push(`Bun ${bun} does not match the release evidence pin ${bunReleasePin}`);
	if (!python?.startsWith(`Python ${pythonReleaseSeries}`)) {
		issues.push(`${python} does not match the release evidence series Python ${pythonReleaseSeries}x`);
	}
	return issues;
};

export const validateReleaseLedger = (artifacts, descriptors) => {
	const expected = descriptors.map((descriptor) => descriptor.key ?? descriptor.name).sort();
	const actual = artifacts.map((artifact) => artifact.key).sort();
	const issues = [];
	if (new Set(actual).size !== actual.length) issues.push("release artifact ledger contains duplicate descriptors");
	for (const key of expected) if (!actual.includes(key)) issues.push(`release artifact ledger omitted ${key}`);
	for (const key of actual) if (!expected.includes(key)) issues.push(`release artifact ledger contains unexpected ${key}`);
	for (const artifact of artifacts) {
		const descriptor = descriptors.find((candidate) => (candidate.key ?? candidate.name) === artifact.key);
		if (descriptor === undefined) continue;
		if (artifact.name !== descriptor.name) issues.push(`${artifact.key} has package name ${String(artifact.name)}, expected ${descriptor.name}`);
		if (artifact.directory !== descriptor.directory) issues.push(`${artifact.key} has package directory ${String(artifact.directory)}, expected ${descriptor.directory}`);
		if (typeof artifact.version !== "string" || artifact.version.length === 0) issues.push(`${artifact.key} has no package version`);
		if (descriptor.executorPlatformTag !== undefined && !artifact.version?.endsWith(`-${descriptor.executorPlatformTag}`)) {
			issues.push(`${artifact.key} has a version that does not match its platform tag`);
		}
		if (!/^[0-9a-f]{64}$/u.test(artifact.sha256 ?? "")) issues.push(`${artifact.key} has an invalid tarball hash`);
		if (typeof artifact.evidenceTarball !== "string" || !artifact.evidenceTarball.startsWith("release-tarballs/")) {
			issues.push(`${artifact.key} has no safe evidence tarball path`);
		}
		if (typeof artifact.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(artifact.integrity)) issues.push(`${artifact.key} has invalid npm integrity`);
		if (!/^[0-9a-f]{64}$/u.test(artifact.manifestSha256 ?? "")) issues.push(`${artifact.key} has an invalid manifest hash`);
		if (!Array.isArray(artifact.files) || !artifact.files.includes("package.json")) issues.push(`${artifact.key} has no package manifest`);
		else {
			if (new Set(artifact.files).size !== artifact.files.length) issues.push(`${artifact.key} has duplicate tarball paths`);
			if (canonicalJson(artifact.files) !== canonicalJson([...artifact.files].sort())) issues.push(`${artifact.key} tarball paths are not canonical`);
			for (const requiredFile of descriptor.requiredFiles ?? []) {
				if (!artifact.files.includes(requiredFile)) issues.push(`${artifact.key} omitted required file ${requiredFile}`);
			}
		}
		const sourceInputs = Array.isArray(artifact.sourceInputs) ? artifact.sourceInputs : [];
		if (canonicalJson(sourceInputs.map((entry) => entry.path).sort()) !== canonicalJson((artifact.files ?? []).map((path) => `${artifact.directory}/${path}`).sort())) {
			issues.push(`${artifact.key} source input ledger does not match its tarball file list`);
		}
		for (const input of sourceInputs) {
			if (!/^[0-9a-f]{64}$/u.test(input.sha256 ?? "") || !Number.isSafeInteger(input.bytes) || input.bytes < 0) {
				issues.push(`${artifact.key} has invalid source input evidence for ${String(input.path)}`);
			}
		}
		if (canonicalJson(artifact.runtimeLimitations ?? []) !== canonicalJson(descriptor.runtimeLimitations ?? [])) {
			issues.push(`${artifact.key} runtime limitations differ from its release descriptor`);
		}
		if (canonicalJson(artifact.releaseBlockers ?? []) !== canonicalJson(descriptor.releaseBlockers ?? [])) {
			issues.push(`${artifact.key} release blockers differ from its release descriptor`);
		}
	}
	return issues;
};

export const verifyReleaseSourceInputs = ({ repoRoot, artifacts }) => {
	const issues = [];
	for (const artifact of artifacts) {
		for (const input of artifact.sourceInputs ?? []) {
			try {
				const bytes = readSafeEvidence(repoRoot, input.path, 128 * 1024 * 1024);
				if (bytes.byteLength !== input.bytes || sha256(bytes) !== input.sha256) issues.push(`stale release input hash for ${input.path}`);
			} catch (error) {
				issues.push(error instanceof Error ? error.message : String(error));
			}
		}
		try {
			const manifestBytes = readSafeEvidence(repoRoot, `${artifact.directory}/package.json`, 4 * 1024 * 1024);
			const manifest = JSON.parse(manifestBytes.toString("utf8"));
			if (sha256(manifestBytes) !== artifact.manifestSha256) issues.push(`stale release manifest hash for ${artifact.key}`);
			if (manifest.name !== artifact.name || manifest.version !== artifact.version) {
				issues.push(`release manifest identity differs for ${artifact.key}`);
			}
			if (canonicalJson(manifest.dependencies ?? {}) !== canonicalJson(artifact.manifestDependencies ?? {})) {
				issues.push(`release manifest dependencies differ for ${artifact.key}`);
			}
			if (canonicalJson(manifest.optionalDependencies ?? {}) !== canonicalJson(artifact.manifestOptionalDependencies ?? {})) {
				issues.push(`release manifest optional dependencies differ for ${artifact.key}`);
			}
		} catch (error) {
			issues.push(error instanceof Error ? error.message : String(error));
		}
	}
	return issues;
};

export const verifyReleaseArtifactFiles = ({ outputRoot, indexedPaths, artifacts }) => {
	const issues = [];
	for (const artifact of artifacts) {
		if (!indexedPaths.has(artifact.evidenceTarball)) {
			issues.push(`${artifact.key} evidence tarball is not indexed`);
			continue;
		}
		try {
			const bytes = readSafeEvidence(outputRoot, artifact.evidenceTarball, 512 * 1024 * 1024);
			if (sha256(bytes) !== artifact.sha256 || bytes.byteLength !== artifact.bytes) {
				issues.push(`${artifact.key} evidence tarball bytes differ from the ledger`);
			}
		} catch (error) {
			issues.push(error instanceof Error ? error.message : String(error));
		}
	}
	return issues;
};

export const buildEvidenceIndex = ({ files, inputs, releaseDescriptorKeys }) => ({
	schemaVersion: EVIDENCE_SCHEMA_VERSION,
	algorithm: "SHA-256",
	releaseDescriptorKeys: [...releaseDescriptorKeys].sort(),
	inputs: [...inputs].sort((left, right) => left.path.localeCompare(right.path)),
	files: [...files].sort((left, right) => left.path.localeCompare(right.path)),
});

export const verifyEvidenceIndex = ({
	outputRoot,
	repoRoot,
	index,
	expectedFiles,
	expectedDescriptorKeys,
	expectedInputs = [],
}) => {
	const issues = [];
	const indexedFiles = new Map(index.files.map((entry) => [entry.path, entry]));
	const indexedInputs = new Set(index.inputs.map((entry) => entry.path));
	for (const path of expectedInputs) if (!indexedInputs.has(path)) issues.push(`evidence index omitted required input ${path}`);
	const actualFiles = [];
	for (const entry of readdirSync(outputRoot, { recursive: true, withFileTypes: true })) {
		const path = relative(outputRoot, resolve(entry.parentPath, entry.name)).replaceAll("\\", "/");
		if (entry.isSymbolicLink()) issues.push(`evidence output contains a symlink: ${path}`);
		if (entry.isFile() && path !== "evidence-index.json" && path !== "SHA256SUMS") actualFiles.push(path);
	}
	if (canonicalJson(actualFiles.sort()) !== canonicalJson([...indexedFiles.keys()].sort())) {
		issues.push("evidence output inventory differs from the exact evidence index");
	}
	for (const path of expectedFiles) if (!indexedFiles.has(path)) issues.push(`evidence index omitted ${path}`);
	for (const [path, entry] of indexedFiles) {
		try {
			const bytes = readSafeEvidence(outputRoot, path, 128 * 1024 * 1024);
			if (sha256(bytes) !== entry.sha256 || bytes.byteLength !== entry.bytes) issues.push(`stale evidence hash for ${path}`);
		} catch (error) {
			issues.push(error instanceof Error ? error.message : String(error));
		}
	}
	for (const input of index.inputs) {
		try {
			if (sha256(readSafeEvidence(repoRoot, input.path, 128 * 1024 * 1024)) !== input.sha256) issues.push(`stale input hash for ${input.path}`);
		} catch (error) {
			issues.push(error instanceof Error ? error.message : String(error));
		}
	}
	const actualKeys = [...index.releaseDescriptorKeys].sort();
	const expectedKeys = [...expectedDescriptorKeys].sort();
	if (canonicalJson(actualKeys) !== canonicalJson(expectedKeys)) issues.push("evidence index release descriptor set is stale or incomplete");
	return issues;
};

export const validateLicenseTextReferences = ({ outputRoot, report, indexedPaths }) => {
	const issues = [];
	const byFile = new Map((report.licenseTexts ?? []).map((entry) => [entry.file, entry]));
	const references = [
		...(report.components ?? []).map((component) => ({
			file: component.licenseTextFile,
			sha256: component.evidenceSha256,
			label: `${component.scope}:${component.bomRef}`,
		})),
		...(report.artifacts ?? []).map((artifact) => ({
			file: artifact.license.textFile,
			sha256: artifact.license.rootLicenseSha256,
			label: artifact.key,
		})),
		...(report.nestedV1License === undefined
			? []
			: [
					{
						file: report.nestedV1License.textFile,
						sha256: report.nestedV1License.sha256,
						label: "embedded-v1-source",
					},
				]),
	].filter((reference) => reference.file !== null && reference.file !== undefined);
	for (const reference of references) {
		if (!indexedPaths.has(reference.file)) issues.push(`${reference.label} references unindexed license text ${reference.file}`);
		const entry = byFile.get(reference.file);
		if (entry === undefined || entry.sha256 !== reference.sha256) {
			issues.push(`${reference.label} references missing or mismatched license text metadata`);
		}
	}
	for (const [file, entry] of byFile) {
		try {
			const bytes = readSafeEvidence(outputRoot, file, 2 * 1024 * 1024);
			if (sha256(bytes) !== entry.sha256 || bytes.toString("utf8") !== entry.text) issues.push(`license text ${file} is stale`);
		} catch (error) {
			issues.push(error instanceof Error ? error.message : String(error));
		}
	}
	return issues;
};

export const relativeEvidencePath = (root, path) => {
	const value = relative(root, path).replaceAll("\\", "/");
	return validateRelativePath(value);
};
