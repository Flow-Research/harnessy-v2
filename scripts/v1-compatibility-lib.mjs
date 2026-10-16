import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const V1_PROVENANCE_SCHEMA_VERSION = 2;
export const V1_LEGACY_PROVENANCE_SCHEMA_VERSION = 1;

// npm omits these ignore files even when the directory is explicitly packed.
// Keep their original bytes in transport metadata, never change the source digest.
const npmOmittedSourceFiles = [".gitignore", "jarvis-cli/.gitignore"];

export const writeV1NpmTransport = async (packageRoot) => {
	const resources = join(resolve(packageRoot), "resources");
	const files = Object.fromEntries(await Promise.all(npmOmittedSourceFiles.map(async (path) =>
		[path, (await readFile(join(resources, "source", path))).toString("base64")],
	)));
	await writeFile(join(resources, "npm-transport.json"), `${JSON.stringify(files, null, 2)}\n`, { mode: 0o644 });
};

/** Reconstruct a fresh inert source candidate from a packed capability; never activate it. */
export const stageV1Compatibility = async (packageRoot, destination) => {
	const input = await realpath(packageRoot);
	const output = join(await realpath(dirname(resolve(destination))), basename(destination));
	if (input === output || input.startsWith(`${output}${sep}`) || output.startsWith(`${input}${sep}`)) {
		throw new Error("V1 staging input and output must be disjoint");
	}
	const resources = join(input, "resources");
	const transportStat = await lstat(join(resources, "npm-transport.json"));
	if (!transportStat.isFile() || transportStat.size > 100_000) throw new Error("Unsafe V1 npm transport file");
	const before = await describeV1Tree(resources);
	const transport = JSON.parse(await readFile(join(resources, "npm-transport.json"), "utf8"));
	if (transport === null || Array.isArray(transport) || typeof transport !== "object" ||
		Object.keys(transport).sort().join("\0") !== [...npmOmittedSourceFiles].sort().join("\0")) {
		throw new Error("Invalid V1 npm transport inventory");
	}
	const files = npmOmittedSourceFiles.map((path) => {
		const value = transport[path];
		if (typeof value !== "string" || value.length > 32_768 || Buffer.from(value, "base64").toString("base64") !== value) {
			throw new Error("Invalid V1 npm transport bytes");
		}
		return [path, Buffer.from(value, "base64")];
	});
	// Validate source/projection paths before copying; the full provenance check
	// below is authoritative only after the exact omitted bytes are reconstructed.
	await inspectV1Compatibility(packageRoot);
	await mkdir(output, { mode: 0o700 });
	await cp(resources, join(output, "resources"), { recursive: true, errorOnExist: true, force: false });
	if ((await describeV1Tree(join(output, "resources"))).digest !== before.digest ||
		(await describeV1Tree(resources)).digest !== before.digest) throw new Error("V1 staging input changed");
	for (const [path, bytes] of [...files.map(([path, bytes]) => [`source/${path}`, bytes]),
		["jarvis-cli/.gitignore", files[1][1]]]) {
		const target = join(output, "resources", path);
		const existing = await lstat(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
		if (existing === null) await writeFile(target, bytes, { flag: "wx", mode: 0o644 });
		else if (!existing.isFile() || !(await readFile(target)).equals(bytes)) throw new Error("V1 npm transport conflicts with source");
	}
	const result = await verifyV1Compatibility(output);
	if (!result.ok) throw new Error(`Reconstructed V1 provenance failed: ${result.issues.join(", ")}`);
	return result;
};

const normalizePath = (value) => value.split(sep).join("/");

const forbiddenRules = [
	{ id: "git-metadata", matches: (path) => path.split("/").includes(".git") },
	{ id: "nested-projects", matches: (path) => path === "projects" || path.startsWith("projects/") },
	{ id: "private-context", matches: (path) => path.split("/").includes("private") },
	{ id: "local-schedule", matches: (path) => path === ".jarvis/cron.yaml" },
	{ id: "runtime-state", matches: (path) => /(^|\/)(queue|weekly-briefings)\.sqlite3$/.test(path) },
	{ id: "review-secret", matches: (path) => /(^|\/)review\.(token|log)$/.test(path) },
	{ id: "environment-secret", matches: (path) => /(^|\/)\.env$/.test(path) },
	{
		id: "generated-cache",
		matches: (path) =>
			path.split("/").some((segment) =>
				[".mypy_cache", ".pytest_cache", ".ruff_cache", ".venv", "__pycache__", "node_modules"].includes(segment),
			),
	},
	{
		id: "coverage-artifact",
		matches: (path) =>
			path.split("/").some((segment) => [".coverage", "coverage.xml", "htmlcov"].includes(segment)) ||
			path.endsWith(".pyc"),
	},
	{ id: "agent-run-state", matches: (path) => /(^|\/)(\.goal-agent|\.playwright-mcp)(\/|$)/.test(path) },
	{ id: "proposal-artifact", matches: (path) => path === "proposals" || path.startsWith("proposals/") },
	{
		id: "sensitive-image",
		matches: (path) =>
			["flow-discord-qr.png", "founder-investments-offer.png", "investments-list-loggedin.png"].includes(
				basename(path),
			),
	},
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const digestV1InputEntries = (entries) =>
	sha256(
		entries
			.map((entry) =>
				[
					entry.path,
					entry.state,
					(entry.origins ?? []).join(","),
					(entry.dirtyStatuses ?? []).join(","),
					entry.trackedAtHead ? "head" : "-",
					entry.trackedInIndex ? "index" : "-",
					entry.size ?? "-",
					entry.executable ? "x" : "-",
					entry.sha256 ?? "-",
				].join("\0"),
			)
			.join("\n"),
	);

const walk = async (root, directory = root, entries = []) => {
	for (const item of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		const absolute = join(directory, item.name);
		const path = normalizePath(relative(root, absolute));
		const info = await lstat(absolute);
		if (info.isSymbolicLink()) throw new Error(`Symlinks are forbidden in the V1 compatibility artifact: ${path}`);
		if (info.isDirectory()) await walk(root, absolute, entries);
		else if (info.isFile()) {
			const content = await readFile(absolute);
			entries.push({
				path,
				size: content.byteLength,
				executable: (info.mode & 0o111) !== 0,
				sha256: sha256(content),
			});
		}
	}
	return entries;
};

export const describeV1Tree = async (root) => {
	const entries = await walk(resolve(root));
	const digestInput = entries
		.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.size}\0${entry.executable ? "x" : "-"}\n`)
		.join("");
	return {
		algorithm: "sha256",
		digest: sha256(digestInput),
		fileCount: entries.length,
		byteCount: entries.reduce((total, entry) => total + entry.size, 0),
		entries,
	};
};

const sameTree = (left, right) =>
	left.digest === right.digest && left.fileCount === right.fileCount && left.byteCount === right.byteCount;

const projectionDefinitions = [
	{ id: "flow-install", source: "tools/flow-install", projection: "flow-install" },
	{ id: "context-vault", source: ".jarvis/context", projection: "context-vault" },
	{ id: "jarvis-cli", source: "jarvis-cli", projection: "jarvis-cli" },
];

const fileProjectionDefinitions = [
	{ id: "root-installer", source: "install.sh", projection: "install.sh", executable: true },
	{ id: "root-readme", source: "README.md", projection: "README.v1.md", executable: false },
	{ id: "root-agents", source: "AGENTS.md", projection: "AGENTS.v1.md", executable: false },
];

export const inspectV1Compatibility = async (packageRoot) => {
	const resources = join(resolve(packageRoot), "resources");
	const sourceRoot = join(resources, "source");
	const source = await describeV1Tree(sourceRoot);
	const issues = [];

	for (const entry of source.entries) {
		for (const rule of forbiddenRules) {
			if (rule.matches(entry.path)) issues.push(`${rule.id}: ${entry.path}`);
		}
	}

	const projections = [];
	for (const definition of projectionDefinitions) {
		const sourceTree = await describeV1Tree(join(sourceRoot, definition.source));
		const projectionTree = await describeV1Tree(join(resources, definition.projection));
		const matches = sameTree(sourceTree, projectionTree);
		if (!matches) issues.push(`projection-drift: ${definition.id}`);
		projections.push({
			id: definition.id,
			source: definition.source,
			projection: definition.projection,
			digest: sourceTree.digest,
			fileCount: sourceTree.fileCount,
			byteCount: sourceTree.byteCount,
			matches,
		});
	}

	for (const definition of fileProjectionDefinitions) {
		const sourcePath = join(sourceRoot, definition.source);
		const projectionPath = join(resources, definition.projection);
		const [sourceContent, projectionContent, sourceInfo, projectionInfo] = await Promise.all([
			readFile(sourcePath),
			readFile(projectionPath),
			lstat(sourcePath),
			lstat(projectionPath),
		]);
		const matches =
			sha256(sourceContent) === sha256(projectionContent) &&
			(!definition.executable || ((sourceInfo.mode & 0o111) !== 0 && (projectionInfo.mode & 0o111) !== 0));
		if (!matches) issues.push(`projection-drift: ${definition.id}`);
		projections.push({
			id: definition.id,
			source: definition.source,
			projection: definition.projection,
			digest: sha256(sourceContent),
			fileCount: 1,
			byteCount: sourceContent.byteLength,
			matches,
		});
	}

	return { source, projections, issues: [...new Set(issues)].sort() };
};

export const readV1Provenance = async (packageRoot) =>
	JSON.parse(await readFile(join(resolve(packageRoot), "resources", "SOURCE.json"), "utf8"));

export const verifyV1Compatibility = async (packageRoot) => {
	const inspection = await inspectV1Compatibility(packageRoot);
	const provenance = await readV1Provenance(packageRoot);
	const issues = [...inspection.issues];
	if (![V1_LEGACY_PROVENANCE_SCHEMA_VERSION, V1_PROVENANCE_SCHEMA_VERSION].includes(provenance.schemaVersion))
		issues.push(`unsupported-provenance-schema: ${String(provenance.schemaVersion)}`);
	if (provenance.tree?.digest !== inspection.source.digest) issues.push("source-digest-mismatch");
	if (provenance.tree?.fileCount !== inspection.source.fileCount) issues.push("source-file-count-mismatch");
	if (provenance.tree?.byteCount !== inspection.source.byteCount) issues.push("source-byte-count-mismatch");
	const selectedInputs = provenance.source?.selectedInputs;
	if (provenance.schemaVersion === V1_PROVENANCE_SCHEMA_VERSION && selectedInputs === undefined)
		issues.push("selected-inputs-missing");
	if (selectedInputs !== undefined) {
		if (selectedInputs.algorithm !== "sha256") issues.push("selected-inputs-algorithm-mismatch");
		if (!Array.isArray(selectedInputs.entries)) {
			issues.push("selected-inputs-entries-invalid");
		} else {
			const paths = selectedInputs.entries.map((entry) => entry.path);
			if (paths.some((path) => typeof path !== "string") || new Set(paths).size !== paths.length)
				issues.push("selected-inputs-paths-invalid");
			if (paths.some((path, index) => index > 0 && path < paths[index - 1]))
				issues.push("selected-inputs-paths-unsorted");
			if (
				selectedInputs.entries.some(
					(entry) =>
						!["present", "deleted"].includes(entry.state) ||
						(entry.state === "present" &&
							(typeof entry.size !== "number" ||
								typeof entry.executable !== "boolean" ||
								!/^[0-9a-f]{64}$/.test(entry.sha256))) ||
						(entry.state === "deleted" &&
							(entry.size !== undefined || entry.executable !== undefined || entry.sha256 !== undefined)),
				)
			)
				issues.push("selected-inputs-entry-invalid");
			if (selectedInputs.digest !== digestV1InputEntries(selectedInputs.entries))
				issues.push("selected-inputs-digest-mismatch");
			if (selectedInputs.pathCount !== selectedInputs.entries.length)
				issues.push("selected-inputs-path-count-mismatch");
			if (
				selectedInputs.byteCount !==
				selectedInputs.entries.reduce((total, entry) => total + (typeof entry.size === "number" ? entry.size : 0), 0)
			)
				issues.push("selected-inputs-byte-count-mismatch");
		}
		if (provenance.source.selectedPaths !== selectedInputs.pathCount)
			issues.push("selected-inputs-source-count-mismatch");
	}
	const dirtyInput = provenance.source?.dirtyInput;
	if (provenance.schemaVersion === V1_PROVENANCE_SCHEMA_VERSION && dirtyInput === undefined)
		issues.push("dirty-input-missing");
	if (dirtyInput !== undefined) {
		if (dirtyInput.algorithm !== "sha256") issues.push("dirty-input-algorithm-mismatch");
		if (!/^[0-9a-f]{64}$/.test(dirtyInput.trackedPatchSha256))
			issues.push("tracked-patch-digest-invalid");
		if (dirtyInput.untrackedInputs?.algorithm !== "sha256" || !Array.isArray(dirtyInput.untrackedInputs?.entries)) {
			issues.push("untracked-inputs-invalid");
		} else {
			const untrackedInputs = dirtyInput.untrackedInputs;
			if (untrackedInputs.digest !== digestV1InputEntries(untrackedInputs.entries))
				issues.push("untracked-inputs-digest-mismatch");
			if (untrackedInputs.pathCount !== untrackedInputs.entries.length)
				issues.push("untracked-inputs-path-count-mismatch");
			if (
				untrackedInputs.byteCount !==
				untrackedInputs.entries.reduce(
					(total, entry) => total + (typeof entry.size === "number" ? entry.size : 0),
					0,
				)
			)
				issues.push("untracked-inputs-byte-count-mismatch");
		}
		const expectedDirtyDigest = sha256(
			`tracked-patch\0${dirtyInput.trackedPatchSha256}\0untracked-inputs\0${dirtyInput.untrackedInputs?.digest}\0`,
		);
		if (dirtyInput.digest !== expectedDirtyDigest) issues.push("dirty-input-digest-mismatch");
		if (provenance.source.dirtyPatchSha256 !== dirtyInput.trackedPatchSha256)
			issues.push("dirty-patch-digest-mismatch");
	}
	return { ...inspection, ok: issues.length === 0, issues: [...new Set(issues)].sort(), provenance };
};

export const writeV1Provenance = async (
	packageRoot,
	sourceMetadata,
	{ schemaVersion = V1_PROVENANCE_SCHEMA_VERSION } = {},
) => {
	if (![V1_LEGACY_PROVENANCE_SCHEMA_VERSION, V1_PROVENANCE_SCHEMA_VERSION].includes(schemaVersion))
		throw new Error(`Unsupported V1 provenance schema version: ${String(schemaVersion)}`);
	const inspection = await inspectV1Compatibility(packageRoot);
	if (inspection.issues.length > 0) throw new Error(inspection.issues.join("\n"));
	const provenance = {
		schemaVersion,
		kind: "reconciled-v1-source",
		source: sourceMetadata,
		exclusions: forbiddenRules.map((rule) => rule.id),
		tree: {
			algorithm: inspection.source.algorithm,
			digest: inspection.source.digest,
			fileCount: inspection.source.fileCount,
			byteCount: inspection.source.byteCount,
		},
		projections: inspection.projections.map(({ matches: _matches, ...projection }) => projection),
	};
	const destination = join(resolve(packageRoot), "resources", "SOURCE.json");
	await writeFile(destination, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o644 });
	await chmod(destination, 0o644);
	return provenance;
};
