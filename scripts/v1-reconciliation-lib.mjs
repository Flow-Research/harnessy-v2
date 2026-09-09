import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import {
	describeV1Tree,
	digestV1InputEntries,
	verifyV1Compatibility,
	writeV1NpmTransport,
	writeV1Provenance,
} from "./v1-compatibility-lib.mjs";

export const DEFAULT_RECONCILIATION_BASE = "511acb5";
export const DEFAULT_SNAPSHOT_BASE_COMMIT = "bae3fdddd99eabe649d0d53cea5d2a0b501aa8b3";
export const DEFAULT_OVERLAY_COMMITS = ["9abb4d5", "ec83bdc", "807d5c0", "afffffb"];

export const DEFAULT_KEEP_SNAPSHOT_PATHS = new Set([
	".jarvis/context/docs/standards/ci-process.md",
	".jarvis/context/profiles/ci.json",
	".jarvis/context/skills/_catalog.md",
]);

export const DEFAULT_TAKE_SOURCE_PATHS = new Set([
	".jarvis/context/docs/operations/meeting-publication.md",
	"jarvis-cli/AGENTS.md",
	"jarvis-cli/src/jarvis/meetings/cli.py",
	"jarvis-cli/src/jarvis/meetings/publication/notes.py",
	"jarvis-cli/src/jarvis/meetings/publication/review.py",
	"jarvis-cli/src/jarvis/meetings/publication/service.py",
	"jarvis-cli/src/jarvis/meetings/service.py",
	"jarvis-cli/tests/unit/meetings/publication/test_notes_store.py",
	"jarvis-cli/tests/unit/meetings/publication/test_service_review.py",
	"jarvis-cli/tests/unit/meetings/test_service.py",
	"tools/flow-install/lib/skills.mjs",
	"tools/flow-install/scripts/flow-cron",
	"tools/flow-install/skills/dependency-manager/manifest.yaml",
	"tools/flow-install/skills/jarvis/commands/jarvis.md",
	"tools/flow-install/skills/jarvis/manifest.yaml",
	"tools/flow-install/skills/service-deploy/scripts/harness-deploy",
	"tools/flow-install/skills/tmux-agent-launcher/SKILL.md",
	"tools/flow-install/skills/tmux-agent-launcher/commands/tmux-agent-launcher.md",
	"tools/flow-install/skills/tmux-agent-launcher/manifest.yaml",
	"tools/flow-install/skills/tmux-agent-launcher/scripts/tmux-agent-launcher",
	"tools/flow-install/tests/test_flow_cron.py",
	"tools/flow-install/tests/test_tmux_agent_launcher.py",
]);

const projectionDefinitions = [
	{ source: "tools/flow-install", projection: "flow-install" },
	{ source: ".jarvis/context", projection: "context-vault" },
	{ source: "jarvis-cli", projection: "jarvis-cli" },
];

const fileProjectionDefinitions = [
	{ source: "install.sh", projection: "install.sh" },
	{ source: "README.md", projection: "README.v1.md" },
	{ source: "AGENTS.md", projection: "AGENTS.v1.md" },
];

const retainedMigrationControlDocuments = [
	{ source: "AGENTS.md", projection: "AGENTS.v1.md" },
	{ source: "README.md", projection: "README.v1.md" },
];

const normalizePath = (value) => value.split(sep).join("/");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sameTree = (left, right) =>
	left.digest === right.digest && left.fileCount === right.fileCount && left.byteCount === right.byteCount;

const assertSafeRelativePath = (path) => {
	if (
		path.length === 0 ||
		path.includes("\0") ||
		path.startsWith("/") ||
		path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
	)
		throw new Error(`Unsafe Git path: ${JSON.stringify(path)}`);
	return path;
};

export const allowedV1SourcePath = (path) => {
	if (
		path === ".jarvis/context/projects.md" ||
		path.startsWith("projects/") ||
		path.startsWith("proposals/") ||
		path.startsWith("tools/flow-install/skills/community-skills-install/")
	)
		return false;
	if (
		[
			"checkin-reworded-pipeline.png",
			"flow-discord-qr.png",
			"flow-harnessy-strategy-brief.pdf",
			"flow-harnessy-strategy-brief.txt",
			"founder-investments-offer.png",
			"investments-list-loggedin.png",
		].includes(path)
	)
		return false;
	return (
		path === ".gitignore" ||
		path === ".github/workflows/jarvis-cli.yml" ||
		path === ".jarvis/context/README.md" ||
		path.startsWith(".jarvis/context/docs/") ||
		path === ".jarvis/context/profiles/ci.json" ||
		path === ".jarvis/context/skills/_catalog.md" ||
		path.startsWith("jarvis-cli/") ||
		path.startsWith("tools/flow-install/")
	);
};

const reviewedV1Exclusions = new Map([
	[".jarvis/context/projects.md", { category: "private-live-state", reason: "workspace-project-inventory" }],
	["checkin-reworded-pipeline.png", { category: "non-runtime-generated", reason: "rendered-review-artifact" }],
	["download.html", { category: "non-runtime-generated", reason: "download-artifact" }],
	["flow-discord-qr.png", { category: "private-live-state", reason: "sensitive-qr-artifact" }],
	["flow-harnessy-strategy-brief.pdf", { category: "non-runtime-generated", reason: "strategy-brief-artifact" }],
	["flow-harnessy-strategy-brief.txt", { category: "non-runtime-generated", reason: "strategy-brief-artifact" }],
	["founder-investments-offer.png", { category: "private-live-state", reason: "private-account-screenshot" }],
	["investments-list-loggedin.png", { category: "private-live-state", reason: "private-account-screenshot" }],
	["proposals/CLA.md", { category: "non-runtime-generated", reason: "proposal-artifact" }],
	["proposals/DCO.md", { category: "non-runtime-generated", reason: "proposal-artifact" }],
	["proposals/README.md", { category: "non-runtime-generated", reason: "proposal-artifact" }],
	["proposals/build_etranzact_discovery_deck.py", { category: "non-runtime-generated", reason: "proposal-artifact" }],
	["proposals/content-batch-jul6-11.md", { category: "non-runtime-generated", reason: "proposal-artifact" }],
	["proposals/dual-entity-flow-itana.md", { category: "non-runtime-generated", reason: "proposal-artifact" }],
	["proposals/etranzact-flow-discovery-deck.pdf", { category: "non-runtime-generated", reason: "proposal-artifact" }],
	["proposals/etranzact-flow-discovery-deck.pptx", { category: "non-runtime-generated", reason: "proposal-artifact" }],
	["proposals/partnership-3mtt.md", { category: "non-runtime-generated", reason: "proposal-artifact" }],
	["proposals/partnership-inubu.md", { category: "non-runtime-generated", reason: "proposal-artifact" }],
	["proposals/partnership-nithub.md", { category: "non-runtime-generated", reason: "proposal-artifact" }],
]);

const temporaryVisualReviewPattern =
	/^\.tmp-sgci-visual-review\.[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/current\.(?:pdf|png)$/u;

export const classifyReviewedV1Exclusion = (path) => {
	const exact = reviewedV1Exclusions.get(path);
	if (exact !== undefined) return { path, ...exact };
	if (temporaryVisualReviewPattern.test(path))
		return {
			path,
			category: "non-runtime-generated",
			reason: "temporary-visual-review-artifact",
		};
	return null;
};

const reviewedV1MigrationControlExclusions = new Map([
	[
		"AGENTS.md",
		{
			category: "migration-control",
			reason: "v2-canonical-deprecation-pointer",
			tracking: "tracked-at-head",
		},
	],
	[
		"README.md",
		{
			category: "migration-control",
			reason: "v2-canonical-deprecation-pointer",
			tracking: "tracked-at-head",
		},
	],
]);

const reviewedV1MigrationControlPaths = [...reviewedV1MigrationControlExclusions.keys()].sort();

export const classifyReviewedV1MigrationControlExclusion = (path) => {
	const reviewed = reviewedV1MigrationControlExclusions.get(path);
	return reviewed === undefined ? null : { path, ...reviewed };
};

const runGit = (sourceRoot, args, options = {}) => {
	const result = spawnSync("git", args, {
		cwd: sourceRoot,
		encoding: options.encoding ?? "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.status !== 0 && !options.allowFailure) {
		const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
		throw new Error(stderr || `git ${args.join(" ")} failed with exit ${String(result.status)}`);
	}
	return result;
};

const resolveCommit = (sourceRoot, revision) =>
	runGit(sourceRoot, ["rev-parse", "--verify", `${revision}^{commit}`]).stdout.trim();

const assertAncestor = (sourceRoot, ancestor, descendant, label) => {
	const result = runGit(sourceRoot, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFailure: true });
	if (result.status === 1) throw new Error(`${label}: ${ancestor} is not an ancestor of ${descendant}`);
	if (result.status !== 0) throw new Error(result.stderr || `Unable to validate ancestry for ${label}`);
};

export const parsePorcelainV1Z = (output) => {
	const tokens = output.toString("utf8").split("\0");
	if (tokens.at(-1) === "") tokens.pop();
	const entries = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const record = tokens[index];
		if (record.length < 4 || record[2] !== " ") throw new Error(`Malformed porcelain record: ${record}`);
		const status = record.slice(0, 2);
		const path = assertSafeRelativePath(normalizePath(record.slice(3)));
		let originalPath;
		if (/[RC]/.test(status)) {
			index += 1;
			if (index >= tokens.length) throw new Error(`Missing original path for Git ${status} record: ${path}`);
			originalPath = assertSafeRelativePath(normalizePath(tokens[index]));
		}
		entries.push({ status, path, ...(originalPath === undefined ? {} : { originalPath }) });
	}
	return entries;
};

export const parseDiffTreeNameStatusZ = (output) => {
	const tokens = output.toString("utf8").split("\0");
	if (tokens.at(-1) === "") tokens.pop();
	const entries = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const status = tokens[index];
		if (!/^[ACDMRTUXB][0-9]*$/.test(status)) throw new Error(`Malformed diff-tree status: ${status}`);
		index += 1;
		if (index >= tokens.length) throw new Error(`Missing path for diff-tree status: ${status}`);
		const firstPath = assertSafeRelativePath(normalizePath(tokens[index]));
		if (/^[RC]/.test(status)) {
			index += 1;
			if (index >= tokens.length) throw new Error(`Missing destination path for diff-tree status: ${status}`);
			entries.push({
				status,
				originalPath: firstPath,
				path: assertSafeRelativePath(normalizePath(tokens[index])),
			});
		} else {
			entries.push({ status, path: firstPath });
		}
	}
	return entries;
};

const pathsForEntry = (entry) =>
	entry.originalPath === undefined ? [entry.path] : [entry.originalPath, entry.path];

const collectSourceState = async (
	sourceRoot,
	selectedPaths,
	origins,
	statuses,
	headPaths,
	indexPaths,
	readSourceFile,
) => {
	const entries = [];
	const unsafeInputs = [];
	const sourceFiles = new Map();
	for (const path of selectedPaths) {
		const absolute = join(sourceRoot, path);
		const info = await lstat(absolute).catch(() => undefined);
		const base = {
			path,
			origins: [...(origins.get(path) ?? [])].sort(),
			dirtyStatuses: [...(statuses.get(path) ?? [])].sort(),
			trackedAtHead: headPaths.has(path),
			trackedInIndex: indexPaths.has(path),
		};
		if (info === undefined) {
			entries.push({ ...base, state: "deleted" });
			continue;
		}
		if (!info.isFile() || info.isSymbolicLink()) {
			unsafeInputs.push(`${path}: selected inputs must be regular files`);
			continue;
		}
		const content = await readSourceFile(absolute);
		sourceFiles.set(path, { content, mode: info.mode & 0o777 });
		entries.push({
			...base,
			state: "present",
			size: content.byteLength,
			executable: (info.mode & 0o111) !== 0,
			sha256: sha256(content),
		});
	}
	return {
		selectedInputs: {
			algorithm: "sha256",
			digest: digestV1InputEntries(entries),
			pathCount: entries.length,
			byteCount: entries.reduce((total, entry) => total + (entry.size ?? 0), 0),
			entries,
		},
		unsafeInputs,
		sourceFiles,
	};
};

const describeUntrackedInputs = (selectedInputs, statusEntries) => {
	const untrackedPaths = new Set(statusEntries.filter((entry) => entry.status === "??").flatMap(pathsForEntry));
	const entries = selectedInputs.entries.filter((entry) => untrackedPaths.has(entry.path));
	return {
		algorithm: "sha256",
		digest: digestV1InputEntries(entries),
		pathCount: entries.length,
		byteCount: entries.reduce((total, entry) => total + (entry.size ?? 0), 0),
		entries,
	};
};

const collectReconciliationInput = async ({ sourceRoot, overlayCommits, allowedPath, readSourceFile }) => {
	const origins = new Map();
	const statuses = new Map();
	const addOrigin = (path, origin) => {
		const values = origins.get(path) ?? new Set();
		values.add(origin);
		origins.set(path, values);
	};
	const addStatus = (path, status) => {
		const values = statuses.get(path) ?? new Set();
		values.add(status);
		statuses.set(path, values);
	};

	const overlayEntries = [];
	for (const commit of overlayCommits) {
		const output = runGit(sourceRoot, [
			"diff-tree",
			"--no-commit-id",
			"--name-status",
			"-r",
			"-z",
			"-M",
			`${commit}^`,
			commit,
		]).stdout;
		for (const entry of parseDiffTreeNameStatusZ(output)) {
			overlayEntries.push({ commit, ...entry });
			for (const path of pathsForEntry(entry)) addOrigin(path, `overlay:${commit}`);
		}
	}

	const headPaths = new Set(
		runGit(sourceRoot, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]).stdout.split("\0").filter(Boolean),
	);
	const indexPaths = new Set(
		runGit(sourceRoot, ["ls-files", "--cached", "-z"]).stdout.split("\0").filter(Boolean),
	);
	const reviewedMigrationControlExclusions = reviewedV1MigrationControlPaths
		.filter((path) => headPaths.has(path))
		.map((path) => classifyReviewedV1MigrationControlExclusion(path));
	const migrationControlStatusExclusions = reviewedMigrationControlExclusions.map(
		({ path }) => `:(exclude,top,literal)${path}`,
	);
	const porcelain = runGit(sourceRoot, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
		"--",
		".",
		...migrationControlStatusExclusions,
	]).stdout;
	const statusEntries = parsePorcelainV1Z(porcelain);
	for (const entry of statusEntries) {
		for (const path of pathsForEntry(entry)) {
			addOrigin(path, "dirty");
			addStatus(path, entry.status);
		}
	}

	const overlayPaths = [...new Set(overlayEntries.flatMap(pathsForEntry))].sort();
	const dirtyPaths = [...new Set(statusEntries.flatMap(pathsForEntry))].sort();
	const selectedPaths = [...new Set([...overlayPaths, ...dirtyPaths].filter(allowedPath))].sort();
	const rejectedOverlayPaths = overlayPaths.filter((path) => !allowedPath(path));
	const reviewedExclusions = dirtyPaths
		.filter((path) => !allowedPath(path))
		.flatMap((path) => {
			const pathStatuses = statuses.get(path);
			if (pathStatuses?.size !== 1 || !pathStatuses.has("??")) return [];
			const reviewed = classifyReviewedV1Exclusion(path);
			return reviewed === null ? [] : [reviewed];
		})
		.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	const reviewedPaths = new Set(reviewedExclusions.map(({ path }) => path));
	const rejectedDirtyPaths = dirtyPaths.filter((path) => !allowedPath(path) && !reviewedPaths.has(path));
	const sourceState = await collectSourceState(
		sourceRoot,
		selectedPaths,
		origins,
		statuses,
		headPaths,
		indexPaths,
		readSourceFile,
	);
	const trackedPatch = runGit(
		sourceRoot,
		[
			"diff",
			"--binary",
			"--full-index",
			"--no-ext-diff",
			"HEAD",
			"--",
			".",
			...reviewedV1MigrationControlPaths.map((path) => `:(exclude,top,literal)${path}`),
		],
		{ encoding: "buffer" },
	).stdout;
	const untrackedInputs = describeUntrackedInputs(sourceState.selectedInputs, statusEntries);
	const trackedPatchSha256 = sha256(Buffer.from(trackedPatch));
	const dirtyInputDigest = sha256(
		`tracked-patch\0${trackedPatchSha256}\0untracked-inputs\0${untrackedInputs.digest}\0`,
	);

	return {
		overlayEntries,
		statusEntries,
		selectedPaths,
		rejectedOverlayPaths,
		rejectedDirtyPaths,
		reviewedExclusions,
		reviewedMigrationControlExclusions,
		missingMigrationControlPaths: reviewedV1MigrationControlPaths.filter((path) => !headPaths.has(path)),
		selectedInputs: sourceState.selectedInputs,
		unsafeInputs: sourceState.unsafeInputs,
		sourceFiles: sourceState.sourceFiles,
		dirtyInput: {
			algorithm: "sha256",
			digest: dirtyInputDigest,
			trackedPatchSha256,
			untrackedInputs,
		},
		dirtyPaths,
	};
};

const validateRetainedMigrationControlDocuments = async (resources) => {
	for (const { source, projection } of retainedMigrationControlDocuments) {
		const sourcePath = join(resources, "source", source);
		const projectionPath = join(resources, projection);
		const [sourceInfo, projectionInfo] = await Promise.all([
			lstat(sourcePath).catch(() => undefined),
			lstat(projectionPath).catch(() => undefined),
		]);
		if (sourceInfo === undefined || projectionInfo === undefined)
			throw new Error(`Retained V1 migration-control document is missing: ${source} / ${projection}`);
		if (
			!sourceInfo.isFile() ||
			sourceInfo.isSymbolicLink() ||
			!projectionInfo.isFile() ||
			projectionInfo.isSymbolicLink()
		)
			throw new Error(`Retained V1 migration-control document must be a regular file: ${source} / ${projection}`);
		const [sourceContent, projectionContent] = await Promise.all([readFile(sourcePath), readFile(projectionPath)]);
		if (!sourceContent.equals(projectionContent))
			throw new Error(`Retained V1 migration-control document pair drifted: ${source} / ${projection}`);
	}
};

const makeScratchRoot = async (prefix, protectedRoots) => {
	const root = await mkdtemp(join(await realpath(tmpdir()), prefix));
	try {
		const canonicalRoot = await realpath(root);
		if (
			protectedRoots.some(
				(protectedRoot) => canonicalRoot === protectedRoot || canonicalRoot.startsWith(`${protectedRoot}${sep}`),
			)
		)
			throw new Error(`OS scratch directory resolved inside a protected tree: ${canonicalRoot}`);
		return canonicalRoot;
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
};

const preserveCommandTreeDocumentation = (sourceContent, snapshotContent) => {
	const snapshot = snapshotContent.toString("utf8");
	const source = sourceContent.toString("utf8");
	const helperStart = snapshot.indexOf("def _normalize_docs_default(");
	const helperEnd = snapshot.indexOf("\ndef _generate_docs()", helperStart);
	if (helperStart < 0 || helperEnd < 0) throw new Error("Snapshot command-tree documentation helpers are missing.");
	const helpers = snapshot.slice(helperStart, helperEnd);
	let merged = source.replace("def _generate_docs() -> dict:\n", `${helpers}\n\ndef _generate_docs() -> dict:\n`);
	const functionStart = merged.indexOf("def _generate_docs() -> dict:");
	const formatterStart = merged.indexOf("\ndef _format_docs_markdown", functionStart);
	if (functionStart < 0 || formatterStart < 0) throw new Error("Current V1 documentation function is missing.");
	const functionBody = merged.slice(functionStart, formatterStart);
	const withVariable = functionBody.replace("    return {\n", "    documentation = {\n");
	const finalBrace = withVariable.lastIndexOf("    }\n");
	if (finalBrace < 0) throw new Error("Current V1 documentation mapping is malformed.");
	const withTree = `${withVariable.slice(0, finalBrace + 6)}    documentation["command_tree"] = _generate_command_tree(cli, ["jarvis"])\n    return documentation\n`;
	merged = `${merged.slice(0, functionStart)}${withTree}${merged.slice(formatterStart)}`;
	return Buffer.from(merged);
};

const mergePyprojectDependencies = (sourceContent, snapshotContent) => {
	const source = sourceContent.toString("utf8");
	let snapshot = snapshotContent.toString("utf8");
	if (!snapshot.includes('"markdown-it-py>=3.0.0"'))
		snapshot = snapshot.replace('    "httpx>=0.27.0",\n', '    "httpx>=0.27.0",\n    "markdown-it-py>=3.0.0",\n');
	for (const setting of ["requires-python", "name", "version"]) {
		const expected = source.split("\n").find((line) => line.startsWith(`${setting} = `));
		if (expected !== undefined && !snapshot.includes(expected))
			throw new Error(`Snapshot pyproject disagrees with current V1 ${setting}.`);
	}
	return Buffer.from(snapshot);
};

const mergeGitignore = (snapshotContent) => {
	let snapshot = snapshotContent.toString("utf8");
	if (!snapshot.includes(".jarvis/context/evidence/"))
		snapshot = snapshot.replace(
			".jarvis/context/deployments/\n",
			".jarvis/context/deployments/\n.jarvis/context/evidence/\n",
		);
	return Buffer.from(snapshot);
};

const gitFileAt = (sourceRoot, revision, path) => {
	const result = runGit(sourceRoot, ["show", `${revision}:${path}`], { allowFailure: true, encoding: "buffer" });
	return result.status === 0 ? Buffer.from(result.stdout) : undefined;
};

const createReconciliationPlan = async ({
	sourceRoot,
	snapshotRoot,
	selectedPaths,
	selectedInputs,
	sourceFiles,
	reconciliationBase,
	keepSnapshotPaths,
	takeSourcePaths,
}) => {
	const writes = [];
	const deletions = [];
	const unchanged = [];
	const conflicts = [];

	for (const path of selectedPaths) {
		const targetPath = join(snapshotRoot, path);
		const sourceEntry = selectedInputs.get(path);
		const sourceFile = sourceFiles.get(path);
		const targetInfo = await lstat(targetPath).catch(() => undefined);
		if (sourceEntry === undefined) {
			conflicts.push(`${path}: selected source input could not be described`);
			continue;
		}
		if (targetInfo !== undefined && (!targetInfo.isFile() || targetInfo.isSymbolicLink())) {
			conflicts.push(`${path}: snapshot target is not a regular file`);
			continue;
		}

		const targetContent = targetInfo === undefined ? undefined : await readFile(targetPath);
		if (sourceEntry.state === "deleted") {
			if (targetContent === undefined) {
				unchanged.push({ path, decision: "already-absent" });
				continue;
			}
			if (keepSnapshotPaths.has(path) || path === "jarvis-cli/uv.lock") {
				unchanged.push({ path, decision: "keep-snapshot" });
				continue;
			}
			if (takeSourcePaths.has(path)) {
				deletions.push({ path, targetPath, decision: "take-source-deletion" });
				continue;
			}
			const baseContent = gitFileAt(sourceRoot, reconciliationBase, path);
			if (baseContent === undefined) {
				conflicts.push(`${path}: deleted from source but added independently in snapshot`);
			} else if (targetContent.equals(baseContent)) {
				deletions.push({ path, targetPath, decision: "source-deletion" });
			} else {
				conflicts.push(`${path}: source deletion conflicts with snapshot change`);
			}
			continue;
		}

		const { content: sourceContent, mode: sourceMode } = sourceFile;
		if (targetContent === undefined) {
			writes.push({ path, targetPath, content: sourceContent, mode: sourceMode, decision: "new-source" });
			continue;
		}
		const sameMode = (targetInfo.mode & 0o777) === sourceMode;
		if (targetContent.equals(sourceContent) && sameMode) {
			unchanged.push({ path, decision: "identical" });
			continue;
		}
		if (keepSnapshotPaths.has(path) || path === "jarvis-cli/uv.lock") {
			unchanged.push({ path, decision: "keep-snapshot" });
			continue;
		}
		if (takeSourcePaths.has(path)) {
			writes.push({ path, targetPath, content: sourceContent, mode: sourceMode, decision: "take-source" });
			continue;
		}
		if (path === ".gitignore") {
			writes.push({
				path,
				targetPath,
				content: mergeGitignore(targetContent),
				mode: sourceMode,
				decision: "merge-gitignore",
			});
			continue;
		}
		if (path === "jarvis-cli/pyproject.toml") {
			writes.push({
				path,
				targetPath,
				content: mergePyprojectDependencies(sourceContent, targetContent),
				mode: sourceMode,
				decision: "merge-pyproject",
			});
			continue;
		}
		if (path === "jarvis-cli/src/jarvis/cli.py") {
			writes.push({
				path,
				targetPath,
				content: preserveCommandTreeDocumentation(sourceContent, targetContent),
				mode: sourceMode,
				decision: "merge-command-tree",
			});
			continue;
		}
		const baseContent = gitFileAt(sourceRoot, reconciliationBase, path);
		if (baseContent === undefined) {
			conflicts.push(`${path}: added independently in both snapshots`);
			continue;
		}

		const mergeRoot = await makeScratchRoot("harnessy-v1-merge-", [sourceRoot, dirname(dirname(snapshotRoot))]);
		try {
			const oursPath = join(mergeRoot, "ours");
			const basePath = join(mergeRoot, "base");
			const theirsPath = join(mergeRoot, "theirs");
			await Promise.all([
				writeFile(oursPath, targetContent),
				writeFile(basePath, baseContent),
				writeFile(theirsPath, sourceContent),
			]);
			const merge = spawnSync("git", ["merge-file", "-p", oursPath, basePath, theirsPath], {
				encoding: "buffer",
				maxBuffer: 32 * 1024 * 1024,
			});
			if (typeof merge.status === "number" && merge.status > 0 && merge.status <= 127) {
				conflicts.push(`${path}: three-way merge conflict (${String(merge.status)} conflict regions)`);
				continue;
			}
			if (merge.status !== 0) {
				const stderr = Buffer.from(merge.stderr ?? []).toString("utf8");
				throw new Error(stderr || `git merge-file failed for ${path} with exit ${String(merge.status)}`);
			}
			writes.push({
				path,
				targetPath,
				content: Buffer.from(merge.stdout),
				mode: sourceMode,
				decision: "three-way-merge",
			});
		} finally {
			await rm(mergeRoot, { recursive: true, force: true });
		}
	}

	return { writes, deletions, unchanged, conflicts };
};

const applyPlan = async (candidateSnapshotRoot, plan) => {
	for (const deletion of plan.deletions) await rm(join(candidateSnapshotRoot, deletion.path), { force: true });
	for (const write of plan.writes) {
		const destination = join(candidateSnapshotRoot, write.path);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, write.content);
		await chmod(destination, write.mode);
	}
};

const rebuildProjections = async (candidatePackageRoot) => {
	const resources = join(candidatePackageRoot, "resources");
	const sourceRoot = join(resources, "source");
	for (const definition of projectionDefinitions) {
		const destination = join(resources, definition.projection);
		if (!destination.startsWith(`${resources}${sep}`)) throw new Error(`Unsafe projection destination: ${destination}`);
		await rm(destination, { recursive: true, force: true });
		await cp(join(sourceRoot, definition.source), destination, { recursive: true, preserveTimestamps: false });
	}
	for (const definition of fileProjectionDefinitions)
		await cp(join(sourceRoot, definition.source), join(resources, definition.projection));
};

const validateConfiguredHistory = ({
	sourceRoot,
	snapshotBaseCommit,
	reconciliationBase,
	overlayCommits,
	currentHead,
	startingProvenance,
}) => {
	const resolvedSnapshotBase = resolveCommit(sourceRoot, snapshotBaseCommit);
	const resolvedReconciliationBase = resolveCommit(sourceRoot, reconciliationBase);
	const resolvedOverlays = overlayCommits.map((commit) => resolveCommit(sourceRoot, commit));
	const resolvedCurrentHead = resolveCommit(sourceRoot, currentHead);
	if (resolvedOverlays.length > 0) {
		assertAncestor(sourceRoot, resolvedReconciliationBase, resolvedOverlays[0], "reconciliation overlay base");
		for (let index = 1; index < resolvedOverlays.length; index += 1)
			assertAncestor(sourceRoot, resolvedOverlays[index - 1], resolvedOverlays[index], `overlay ${String(index)}`);
		assertAncestor(sourceRoot, resolvedOverlays.at(-1), resolvedCurrentHead, "current source head");
	} else {
		assertAncestor(sourceRoot, resolvedReconciliationBase, resolvedCurrentHead, "current source head");
	}

	const declared = startingProvenance.source ?? {};
	for (const [name, expected, actual] of [
		["snapshotBaseCommit", resolvedSnapshotBase, declared.snapshotBaseCommit],
		["reconciliationBase", resolvedReconciliationBase, declared.reconciliationBase],
	]) {
		if (typeof actual !== "string" || resolveCommit(sourceRoot, actual) !== expected)
			throw new Error(`Starting snapshot ${name} does not match the configured ${name}.`);
	}
	if (!Array.isArray(declared.overlayCommits) || declared.overlayCommits.length !== resolvedOverlays.length)
		throw new Error("Starting snapshot overlay commits do not match the configured overlay commits.");
	for (let index = 0; index < resolvedOverlays.length; index += 1) {
		if (resolveCommit(sourceRoot, declared.overlayCommits[index]) !== resolvedOverlays[index])
			throw new Error(`Starting snapshot overlay commit ${String(index)} does not match configuration.`);
	}
	if (typeof declared.currentHead === "string") {
		const priorHead = resolveCommit(sourceRoot, declared.currentHead);
		assertAncestor(sourceRoot, priorHead, resolvedCurrentHead, "starting snapshot source head");
	}

	return {
		snapshotBaseCommit: resolvedSnapshotBase,
		reconciliationBase: resolvedReconciliationBase,
		overlayCommits: resolvedOverlays,
		currentHead: resolvedCurrentHead,
	};
};

export class V1ReconciliationError extends Error {
	constructor(message, report) {
		super(message);
		this.name = "V1ReconciliationError";
		this.report = report;
	}
}

export const reconcileV1Compatibility = async ({
	sourceRoot: sourceRootInput,
	packageRoot: packageRootInput,
	repositoryRoot: repositoryRootInput,
	dryRun = false,
	snapshotBaseCommit = DEFAULT_SNAPSHOT_BASE_COMMIT,
	reconciliationBase = DEFAULT_RECONCILIATION_BASE,
	overlayCommits = DEFAULT_OVERLAY_COMMITS,
	allowedPath = allowedV1SourcePath,
	keepSnapshotPaths = DEFAULT_KEEP_SNAPSHOT_PATHS,
	takeSourcePaths = DEFAULT_TAKE_SOURCE_PATHS,
	readSourceFile = readFile,
}) => {
	const sourceRoot = await realpath(resolve(sourceRootInput));
	const packageRoot = await realpath(resolve(packageRootInput));
	const resources = join(packageRoot, "resources");
	const snapshotRoot = join(resources, "source");
	const repositoryRoot =
		repositoryRootInput === undefined ? undefined : await realpath(resolve(repositoryRootInput));
	const topLevel = await realpath(resolve(runGit(sourceRoot, ["rev-parse", "--show-toplevel"]).stdout.trim()));
	if (topLevel !== sourceRoot) throw new Error(`--source must be a repository root: ${sourceRoot}`);
	if (repositoryRoot !== undefined && (sourceRoot === repositoryRoot || sourceRoot.startsWith(`${repositoryRoot}${sep}`)))
		throw new Error("The V1 source must not be inside the V2 repository.");

	await validateRetainedMigrationControlDocuments(resources);
	const startingVerification = await verifyV1Compatibility(packageRoot);
	if (!startingVerification.ok)
		throw new Error(`Starting compatibility snapshot is invalid:\n${startingVerification.issues.join("\n")}`);
	const startingResources = await describeV1Tree(resources);
	const currentHead = runGit(sourceRoot, ["rev-parse", "HEAD"]).stdout.trim();
	const history = validateConfiguredHistory({
		sourceRoot,
		snapshotBaseCommit,
		reconciliationBase,
		overlayCommits,
		currentHead,
		startingProvenance: startingVerification.provenance,
	});
	const input = await collectReconciliationInput({ sourceRoot, overlayCommits, allowedPath, readSourceFile });
	const report = {
		ok: false,
		dryRun,
		applied: false,
		sourceRoot,
		packageRoot,
		startingTree: {
			algorithm: startingVerification.source.algorithm,
			digest: startingVerification.source.digest,
			fileCount: startingVerification.source.fileCount,
			byteCount: startingVerification.source.byteCount,
		},
		history,
		selected: input.selectedPaths.length,
		writes: [],
		deletions: [],
		unchanged: [],
		conflicts: [],
		unsafeInputs: input.unsafeInputs,
		rejectedDirtyPaths: input.rejectedDirtyPaths,
		rejectedOverlayPaths: input.rejectedOverlayPaths,
		reviewedExclusions: input.reviewedExclusions,
		reviewedMigrationControlExclusions: input.reviewedMigrationControlExclusions,
		missingMigrationControlPaths: input.missingMigrationControlPaths,
		selectedInputs: input.selectedInputs,
		dirtyInput: input.dirtyInput,
	};
	const inputIssues = [
		...input.missingMigrationControlPaths.map((path) => `migration-control path is not tracked at HEAD: ${path}`),
		...input.rejectedDirtyPaths.map((path) => `rejected dirty path: ${path}`),
		...input.rejectedOverlayPaths.map((path) => `rejected overlay path: ${path}`),
		...input.unsafeInputs,
	];
	if (inputIssues.length > 0)
		throw new V1ReconciliationError(`V1 reconciliation preflight failed:\n${inputIssues.join("\n")}`, report);

	const plan = await createReconciliationPlan({
		sourceRoot,
		snapshotRoot,
		selectedPaths: input.selectedPaths,
		selectedInputs: new Map(input.selectedInputs.entries.map((entry) => [entry.path, entry])),
		sourceFiles: input.sourceFiles,
		reconciliationBase,
		keepSnapshotPaths,
		takeSourcePaths,
	});
	report.writes = plan.writes.map(({ path, decision }) => ({ path, decision }));
	report.deletions = plan.deletions.map(({ path, decision }) => ({ path, decision }));
	report.unchanged = plan.unchanged;
	report.conflicts = plan.conflicts;
	if (plan.conflicts.length > 0)
		throw new V1ReconciliationError(
			`V1 reconciliation preflight failed:\n${plan.conflicts.join("\n")}`,
			report,
		);

	const stageRoot = dryRun
		? await makeScratchRoot(`harnessy-${basename(packageRoot)}-reconcile-`, [sourceRoot, packageRoot])
		: await mkdtemp(join(dirname(packageRoot), `.${basename(packageRoot)}-reconcile-`));
	try {
		const candidatePackageRoot = join(stageRoot, "candidate");
		const candidateResources = join(candidatePackageRoot, "resources");
		await mkdir(candidatePackageRoot, { recursive: true });
		await cp(resources, candidateResources, { recursive: true, preserveTimestamps: false });
		await applyPlan(join(candidateResources, "source"), plan);
		await rebuildProjections(candidatePackageRoot);
		await validateRetainedMigrationControlDocuments(candidateResources);
		const repository = runGit(sourceRoot, ["config", "--get", "remote.origin.url"], { allowFailure: true }).stdout.trim() || null;
		const sourceMetadata = {
			repository,
			snapshotBaseCommit: history.snapshotBaseCommit,
			reconciliationBase: history.reconciliationBase,
			currentHead: history.currentHead,
			overlayCommits: history.overlayCommits,
			dirtyPatchSha256: input.dirtyInput.trackedPatchSha256,
			dirtyInput: input.dirtyInput,
			dirtyPaths: input.dirtyPaths.length,
			selectedPaths: input.selectedPaths.length,
			selectedInputs: input.selectedInputs,
			reviewedExclusions: input.reviewedExclusions,
			reviewedMigrationControlExclusions: input.reviewedMigrationControlExclusions,
			startingTree: report.startingTree,
			mode: input.dirtyPaths.length > 0 ? "reviewed-dirty-overlay" : "committed-overlay",
		};
		await writeV1Provenance(candidatePackageRoot, sourceMetadata);
		await writeV1NpmTransport(candidatePackageRoot);
		const candidateVerification = await verifyV1Compatibility(candidatePackageRoot);
		if (!candidateVerification.ok)
			throw new Error(`Candidate compatibility pack is invalid:\n${candidateVerification.issues.join("\n")}`);
		report.candidateTree = {
			algorithm: candidateVerification.source.algorithm,
			digest: candidateVerification.source.digest,
			fileCount: candidateVerification.source.fileCount,
			byteCount: candidateVerification.source.byteCount,
		};
		report.provenance = sourceMetadata;
		const finalHead = runGit(sourceRoot, ["rev-parse", "HEAD"]).stdout.trim();
		const finalInput = await collectReconciliationInput({ sourceRoot, overlayCommits, allowedPath, readSourceFile });
		if (
			finalHead !== history.currentHead ||
			finalInput.selectedInputs.digest !== input.selectedInputs.digest ||
			finalInput.dirtyInput.digest !== input.dirtyInput.digest ||
			JSON.stringify(finalInput.rejectedDirtyPaths) !== JSON.stringify(input.rejectedDirtyPaths) ||
			JSON.stringify(finalInput.rejectedOverlayPaths) !== JSON.stringify(input.rejectedOverlayPaths) ||
			JSON.stringify(finalInput.reviewedExclusions) !== JSON.stringify(input.reviewedExclusions) ||
			JSON.stringify(finalInput.reviewedMigrationControlExclusions) !==
				JSON.stringify(input.reviewedMigrationControlExclusions) ||
			JSON.stringify(finalInput.missingMigrationControlPaths) !==
				JSON.stringify(input.missingMigrationControlPaths)
		)
			throw new V1ReconciliationError("V1 source changed during reconciliation.", report);
		report.sourceStable = true;

		if (dryRun) {
			report.ok = true;
			return report;
		}

		const currentVerification = await verifyV1Compatibility(packageRoot);
		const currentResources = await describeV1Tree(resources);
		if (!currentVerification.ok || !sameTree(startingResources, currentResources))
			throw new V1ReconciliationError("Authoritative compatibility pack changed during reconciliation.", report);

		const backupResources = join(stageRoot, "original-resources");
		await rename(resources, backupResources);
		try {
			await rename(candidateResources, resources);
		} catch (error) {
			await rename(backupResources, resources);
			throw error;
		}
		await rm(backupResources, { recursive: true, force: true });
		report.ok = true;
		report.applied = true;
		return report;
	} catch (error) {
		if (error instanceof V1ReconciliationError) throw error;
		throw new V1ReconciliationError(error instanceof Error ? error.message : String(error), report);
	} finally {
		await rm(stageRoot, { recursive: true, force: true });
	}
};
