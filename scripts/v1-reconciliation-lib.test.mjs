import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { describeV1Tree, verifyV1Compatibility, writeV1Provenance } from "./v1-compatibility-lib.mjs";
import {
	classifyReviewedV1Exclusion,
	classifyReviewedV1MigrationControlExclusion,
	DEFAULT_TAKE_SOURCE_PATHS,
	reconcileV1Compatibility,
	V1ReconciliationError,
} from "./v1-reconciliation-lib.mjs";

const reviewedExclusionPaths = [
	".jarvis/context/projects.md",
	".tmp-sgci-visual-review.PV2p4C/current.pdf",
	".tmp-sgci-visual-review.PV2p4C/current.png",
	"checkin-reworded-pipeline.png",
	"download.html",
	"flow-discord-qr.png",
	"flow-harnessy-strategy-brief.pdf",
	"flow-harnessy-strategy-brief.txt",
	"founder-investments-offer.png",
	"investments-list-loggedin.png",
	"proposals/CLA.md",
	"proposals/DCO.md",
	"proposals/README.md",
	"proposals/build_etranzact_discovery_deck.py",
	"proposals/content-batch-jul6-11.md",
	"proposals/dual-entity-flow-itana.md",
	"proposals/etranzact-flow-discovery-deck.pdf",
	"proposals/etranzact-flow-discovery-deck.pptx",
	"proposals/partnership-3mtt.md",
	"proposals/partnership-inubu.md",
	"proposals/partnership-nithub.md",
].sort();

const migrationControlExclusionPaths = ["AGENTS.md", "README.md"];

const meetingPublicationTakeSourcePaths = [
	".jarvis/context/docs/operations/meeting-publication.md",
	"jarvis-cli/AGENTS.md",
	"jarvis-cli/src/jarvis/meetings/publication/notes.py",
	"jarvis-cli/src/jarvis/meetings/publication/review.py",
	"jarvis-cli/src/jarvis/meetings/publication/service.py",
	"jarvis-cli/tests/unit/meetings/publication/test_notes_store.py",
	"jarvis-cli/tests/unit/meetings/publication/test_service_review.py",
	"tools/flow-install/skills/jarvis/commands/jarvis.md",
	"tools/flow-install/skills/jarvis/manifest.yaml",
];

const requiredFiles = () =>
	new Map([
		[".gitignore", ".jarvis/context/deployments/\n"],
		[".jarvis/context/README.md", "context baseline\n"],
		["tools/flow-install/base.txt", "installer baseline\n"],
		["jarvis-cli/base.txt", "jarvis baseline\n"],
		["install.sh", "#!/usr/bin/env bash\necho install\n"],
		["README.md", "V1 fixture\n"],
		["AGENTS.md", "fixture rules\n"],
	]);

const runGit = (root, args, options = {}) => {
	const result = spawnSync("git", args, {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_DATE: options.date ?? "2026-01-01T00:00:00Z",
			GIT_COMMITTER_DATE: options.date ?? "2026-01-01T00:00:00Z",
		},
	});
	assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
};

const writeFixtureFile = async (root, path, content) => {
	const destination = join(root, path);
	await mkdir(dirname(destination), { recursive: true });
	await writeFile(destination, content);
	if (path === "install.sh") await chmod(destination, 0o755);
};

const writeFixtureFiles = async (root, files) => {
	for (const [path, content] of files) await writeFixtureFile(root, path, content);
};

const initializeRepository = async (root, files) => {
	await mkdir(root, { recursive: true });
	runGit(root, ["init", "-q", "-b", "main"]);
	runGit(root, ["config", "user.name", "Harnessy Test"]);
	runGit(root, ["config", "user.email", "harnessy-test@example.invalid"]);
	await writeFixtureFiles(root, files);
	runGit(root, ["add", "--", ...files.keys()]);
	runGit(root, ["commit", "-q", "-m", "fixture base"]);
	return runGit(root, ["rev-parse", "HEAD"]);
};

const commitPaths = (root, paths, message, date = "2026-01-02T00:00:00Z") => {
	if (paths.length > 0) runGit(root, ["add", "--", ...paths]);
	runGit(root, ["commit", "-q", "-m", message], { date });
	return runGit(root, ["rev-parse", "HEAD"]);
};

const createCompatibilityPackage = async (packageRoot, files, sourceMetadata) => {
	const resources = join(packageRoot, "resources");
	const source = join(resources, "source");
	await writeFixtureFiles(source, files);
	await cp(join(source, "tools/flow-install"), join(resources, "flow-install"), { recursive: true });
	await cp(join(source, ".jarvis/context"), join(resources, "context-vault"), { recursive: true });
	await cp(join(source, "jarvis-cli"), join(resources, "jarvis-cli"), { recursive: true });
	await cp(join(source, "install.sh"), join(resources, "install.sh"));
	await chmod(join(resources, "install.sh"), 0o755);
	await cp(join(source, "README.md"), join(resources, "README.v1.md"));
	await cp(join(source, "AGENTS.md"), join(resources, "AGENTS.v1.md"));
	await writeV1Provenance(packageRoot, sourceMetadata, { schemaVersion: 1 });
};

const provenanceFor = ({ base, overlays, head = overlays.at(-1) ?? base }) => ({
	repository: null,
	snapshotBaseCommit: base,
	reconciliationBase: base,
	currentHead: head,
	overlayCommits: overlays,
	dirtyPatchSha256: "fixture-pre-reconciliation",
	dirtyPaths: 0,
	selectedPaths: 0,
	mode: "committed-overlay",
});

const makeTemporaryRoots = async (t) => {
	const root = await mkdtemp(join(tmpdir(), "harnessy-v1-reconciliation-test-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return {
		root,
		sourceRoot: join(root, "v1-source"),
		packageRoot: join(root, "capability-harnessy-v1-full"),
	};
};

const assertResourcesUnchanged = async (packageRoot, before) => {
	const after = await describeV1Tree(join(packageRoot, "resources"));
	assert.deepEqual(
		{ digest: after.digest, fileCount: after.fileCount, byteCount: after.byteCount },
		{ digest: before.digest, fileCount: before.fileCount, byteCount: before.byteCount },
	);
};

const readRetainedMigrationControlDocuments = async (packageRoot) =>
	Promise.all(
		[
			"resources/source/AGENTS.md",
			"resources/AGENTS.v1.md",
			"resources/source/README.md",
			"resources/README.v1.md",
		].map(async (path) => [path, await readFile(join(packageRoot, path))]),
	);

const listReconciliationScratch = async () =>
	(await readdir(tmpdir()))
		.filter(
			(path) =>
				path.startsWith("harnessy-v1-merge-") ||
				path.startsWith("harnessy-capability-harnessy-v1-full-reconcile-"),
		)
		.sort();

test("reviewed exclusions are exact, deterministic, and keep near misses unresolved", () => {
	const reviewed = reviewedExclusionPaths.map((path) => classifyReviewedV1Exclusion(path));
	assert(reviewed.every(Boolean));
	assert.equal(reviewed.filter(({ category }) => category === "private-live-state").length, 4);
	assert.equal(reviewed.filter(({ category }) => category === "non-runtime-generated").length, 17);
	assert.deepEqual(
		reviewed.map(({ path }) => path),
		reviewedExclusionPaths,
	);
	assert.deepEqual(
		migrationControlExclusionPaths.map((path) => classifyReviewedV1MigrationControlExclusion(path)),
		migrationControlExclusionPaths.map((path) => ({
			path,
			category: "migration-control",
			reason: "v2-canonical-deprecation-pointer",
			tracking: "tracked-at-head",
		})),
	);
	for (const path of [
		"projects/rejected.txt",
		"proposals/new-unreviewed.md",
		".tmp-sgci-visual-review./current.pdf",
		".tmp-sgci-visual-review.-PV2p4C/current.pdf",
		".tmp-sgci-visual-review.PV2p4C/current.jpeg",
		".tmp-sgci-visual-review.PV2p4C/current.pdf.bak",
		".tmp-sgci-visual-review.PV2p4C/nested/current.png",
		`.tmp-sgci-visual-review.${"a".repeat(65)}/current.png`,
	])
		assert.equal(classifyReviewedV1Exclusion(path), null, path);
	for (const path of ["agents.md", "README.md.bak", "docs/AGENTS.md"])
		assert.equal(classifyReviewedV1MigrationControlExclusion(path), null, path);
	assert(meetingPublicationTakeSourcePaths.every((path) => DEFAULT_TAKE_SOURCE_PATHS.has(path)));
});

test("tracked migration controls and reviewed untracked exclusions are never read or hashed", async (t) => {
	const { sourceRoot, packageRoot } = await makeTemporaryRoots(t);
	const baseline = requiredFiles();
	const base = await initializeRepository(sourceRoot, baseline);
	await createCompatibilityPackage(packageRoot, baseline, provenanceFor({ base, overlays: [] }));
	for (const path of [...reviewedExclusionPaths].reverse())
		await writeFixtureFile(sourceRoot, path, `excluded fixture: ${path}\n`);
	await writeFixtureFile(sourceRoot, "AGENTS.md", "unresolved fixture rules\n");
	await writeFixtureFile(sourceRoot, "README.md", "unresolved fixture readme\n");
	await writeFixtureFile(sourceRoot, "jarvis-cli/base.txt", "eligible tracked input\n");
	await writeFixtureFile(sourceRoot, "jarvis-cli/untracked.txt", "allowed input\n");
	for (const path of [".jarvis/context/projects.md", ...migrationControlExclusionPaths])
		await chmod(join(sourceRoot, path), 0o000);
	t.after(async () => {
		for (const path of [".jarvis/context/projects.md", ...migrationControlExclusionPaths])
			await chmod(join(sourceRoot, path), 0o644).catch(() => undefined);
	});

	const resourcesBefore = await describeV1Tree(join(packageRoot, "resources"));
	const retainedBefore = await readRetainedMigrationControlDocuments(packageRoot);
	const sourceStatusBefore = runGit(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
	const scratchBefore = await listReconciliationScratch();
	const canonicalSourceRoot = await realpath(sourceRoot);
	const excludedAbsolutePaths = new Set(
		[...reviewedExclusionPaths, ...migrationControlExclusionPaths].map((path) => join(canonicalSourceRoot, path)),
	);
	const readPaths = [];
	const readSourceFile = async (path) => {
		assert(!excludedAbsolutePaths.has(path), `reviewed exclusion was read: ${path}`);
		readPaths.push(path);
		return readFile(path);
	};

	const firstReport = await reconcileV1Compatibility({
		sourceRoot,
		packageRoot,
		dryRun: true,
		snapshotBaseCommit: base,
		reconciliationBase: base,
		overlayCommits: [],
		readSourceFile,
	});
	assert.equal(firstReport.ok, true);
	assert.deepEqual(firstReport.rejectedDirtyPaths, []);
	assert.deepEqual(firstReport.rejectedOverlayPaths, []);
	assert.deepEqual(
		firstReport.reviewedExclusions,
		reviewedExclusionPaths.map((path) => classifyReviewedV1Exclusion(path)),
	);
	assert.deepEqual(
		firstReport.reviewedMigrationControlExclusions,
		migrationControlExclusionPaths.map((path) => classifyReviewedV1MigrationControlExclusion(path)),
	);
	assert.deepEqual(firstReport.provenance.reviewedExclusions, firstReport.reviewedExclusions);
	assert.deepEqual(
		firstReport.provenance.reviewedMigrationControlExclusions,
		firstReport.reviewedMigrationControlExclusions,
	);
	assert(firstReport.writes.some(({ path }) => path === "jarvis-cli/base.txt"));
	assert(firstReport.writes.some(({ path }) => path === "jarvis-cli/untracked.txt"));
	assert(
		firstReport.dirtyInput.untrackedInputs.entries.every(
			({ path }) => !reviewedExclusionPaths.includes(path) && !migrationControlExclusionPaths.includes(path),
		),
	);
	assert.equal(
		runGit(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
		sourceStatusBefore,
	);

	for (const [path, content] of [
		["AGENTS.md", "different ignored migration rules\n"],
		["README.md", "different ignored migration readme\n"],
	]) {
		await chmod(join(sourceRoot, path), 0o644);
		await writeFixtureFile(sourceRoot, path, content);
		await chmod(join(sourceRoot, path), 0o000);
	}
	const secondSourceStatusBefore = runGit(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
	const secondReport = await reconcileV1Compatibility({
		sourceRoot,
		packageRoot,
		dryRun: true,
		snapshotBaseCommit: base,
		reconciliationBase: base,
		overlayCommits: [],
		readSourceFile,
	});
	assert.equal(secondReport.dirtyInput.trackedPatchSha256, firstReport.dirtyInput.trackedPatchSha256);
	assert.equal(secondReport.dirtyInput.digest, firstReport.dirtyInput.digest);
	assert.equal(secondReport.selectedInputs.digest, firstReport.selectedInputs.digest);
	assert.deepEqual(secondReport.reviewedMigrationControlExclusions, firstReport.reviewedMigrationControlExclusions);
	assert.equal(
		runGit(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
		secondSourceStatusBefore,
	);

	assert(readPaths.length > 0);
	assert(readPaths.every((path) => !excludedAbsolutePaths.has(path)));
	assert.equal(
		readPaths.every(
			(path) =>
				path === join(canonicalSourceRoot, "jarvis-cli/base.txt") ||
				path === join(canonicalSourceRoot, "jarvis-cli/untracked.txt"),
		),
		true,
	);
	assert.deepEqual(await readRetainedMigrationControlDocuments(packageRoot), retainedBefore);
	assert.deepEqual(await listReconciliationScratch(), scratchBefore);
	await assertResourcesUnchanged(packageRoot, resourcesBefore);
});

test("migration-control disposition applies only when the exact root paths are tracked at HEAD", async (t) => {
	const { sourceRoot, packageRoot } = await makeTemporaryRoots(t);
	const sourceBaseline = requiredFiles();
	sourceBaseline.delete("AGENTS.md");
	sourceBaseline.delete("README.md");
	const base = await initializeRepository(sourceRoot, sourceBaseline);
	await writeFixtureFile(sourceRoot, "AGENTS.md", "untracked rules\n");
	await writeFixtureFile(sourceRoot, "README.md", "untracked readme\n");
	await createCompatibilityPackage(packageRoot, requiredFiles(), provenanceFor({ base, overlays: [] }));
	const resourcesBefore = await describeV1Tree(join(packageRoot, "resources"));

	await assert.rejects(
		reconcileV1Compatibility({
			sourceRoot,
			packageRoot,
			dryRun: true,
			snapshotBaseCommit: base,
			reconciliationBase: base,
			overlayCommits: [],
		}),
		(error) => {
			assert(error instanceof V1ReconciliationError);
			assert.deepEqual(error.report.reviewedMigrationControlExclusions, []);
			assert.deepEqual(error.report.missingMigrationControlPaths, ["AGENTS.md", "README.md"]);
			assert.deepEqual(error.report.rejectedDirtyPaths, ["AGENTS.md", "README.md"]);
			assert.deepEqual(error.report.writes, []);
			return true;
		},
	);
	await assertResourcesUnchanged(packageRoot, resourcesBefore);
});

test("missing or drifted retained migration-control documents fail closed", async (t) => {
	for (const scenario of [
		{
			name: "missing",
			mutate: (packageRoot) => rm(join(packageRoot, "resources/source/AGENTS.md")),
			expected: /Retained V1 migration-control document is missing: AGENTS\.md \/ AGENTS\.v1\.md/,
		},
		{
			name: "drifted",
			mutate: (packageRoot) => writeFile(join(packageRoot, "resources/README.v1.md"), "drifted copy\n"),
			expected: /Retained V1 migration-control document pair drifted: README\.md \/ README\.v1\.md/,
		},
	]) {
		const roots = await makeTemporaryRoots(t);
		const baseline = requiredFiles();
		const base = await initializeRepository(roots.sourceRoot, baseline);
		await createCompatibilityPackage(roots.packageRoot, baseline, provenanceFor({ base, overlays: [] }));
		await scenario.mutate(roots.packageRoot);
		const before = await describeV1Tree(join(roots.packageRoot, "resources"));
		await assert.rejects(
			reconcileV1Compatibility({
				sourceRoot: roots.sourceRoot,
				packageRoot: roots.packageRoot,
				dryRun: true,
				snapshotBaseCommit: base,
				reconciliationBase: base,
				overlayCommits: [],
			}),
			scenario.expected,
			scenario.name,
		);
		await assertResourcesUnchanged(roots.packageRoot, before);
	}
});

test("package README identifies V2 as canonical and the V1 pack as deprecated", async () => {
	const readme = await readFile(new URL("../packages/capability-harnessy-v1-full/README.md", import.meta.url), "utf8");
	assert(readme.includes("Harnessy V2 is canonical for all new Harnessy development."));
	assert(readme.includes("deprecated package"));
	assert(readme.includes("compatibility oracle and source pack"));
	assert(!readme.includes("/Users/"));
});

test("reconciles committed and dirty renames/deletions and binds untracked bytes into provenance", async (t) => {
	const { sourceRoot, packageRoot } = await makeTemporaryRoots(t);
	const baseline = requiredFiles();
	baseline.set(".jarvis/context/docs/delete.md", "delete me\n");
	baseline.set(".jarvis/context/docs/old-name.md", "renamed content\n");
	baseline.set(".jarvis/context/docs/merge.md", "alpha\nsource slot\nmiddle one\nmiddle two\nsnapshot slot\nomega\n");
	baseline.set(".jarvis/context/docs/standards/ci-process.md", "base CI policy\n");
	baseline.set("tools/flow-install/dirty-old.txt", "dirty rename\n");
	baseline.set("tools/flow-install/lib/skills.mjs", "export const choice = 'base';\n");
	baseline.set(
		"jarvis-cli/pyproject.toml",
		'[project]\nname = "jarvis-cli"\nversion = "1.0.0"\nrequires-python = ">=3.11"\ndependencies = [\n    "httpx>=0.27.0",\n]\n',
	);
	baseline.set(
		"jarvis-cli/src/jarvis/cli.py",
		'def _generate_docs() -> dict:\n    return {\n        "base": True,\n    }\n\ndef _format_docs_markdown(value):\n    return value\n',
	);
	const base = await initializeRepository(sourceRoot, baseline);

	runGit(sourceRoot, ["rm", "-q", "--", ".jarvis/context/docs/delete.md"]);
	runGit(sourceRoot, ["mv", ".jarvis/context/docs/old-name.md", ".jarvis/context/docs/new-name.md"]);
	await writeFixtureFile(
		sourceRoot,
		".jarvis/context/docs/merge.md",
		"alpha\nsource changed\nmiddle one\nmiddle two\nsnapshot slot\nomega\n",
	);
	await writeFixtureFile(sourceRoot, ".jarvis/context/docs/standards/ci-process.md", "source CI policy\n");
	await writeFixtureFile(sourceRoot, "tools/flow-install/lib/skills.mjs", "export const choice = 'source';\n");
	await writeFixtureFile(
		sourceRoot,
		".gitignore",
		".jarvis/context/deployments/\nsource-only-ignore\n",
	);
	await writeFixtureFile(
		sourceRoot,
		"jarvis-cli/pyproject.toml",
		'[project]\nname = "jarvis-cli"\nversion = "1.0.0"\nrequires-python = ">=3.11"\ndependencies = [\n    "httpx>=0.27.0",\n    "source-only>=1.0.0",\n]\n',
	);
	await writeFixtureFile(
		sourceRoot,
		"jarvis-cli/src/jarvis/cli.py",
		'def _generate_docs() -> dict:\n    return {\n        "source": True,\n    }\n\ndef _format_docs_markdown(value):\n    return value\n',
	);
	const overlay = commitPaths(
		sourceRoot,
		[
			".gitignore",
			".jarvis/context/docs/merge.md",
			".jarvis/context/docs/standards/ci-process.md",
			"jarvis-cli/pyproject.toml",
			"jarvis-cli/src/jarvis/cli.py",
			"tools/flow-install/lib/skills.mjs",
		],
		"fixture overlay",
	);

	runGit(sourceRoot, ["mv", "tools/flow-install/dirty-old.txt", "tools/flow-install/dirty-new.txt"]);
	await writeFixtureFile(sourceRoot, "jarvis-cli/untracked.txt", "untracked version one\n");

	const snapshot = new Map(baseline);
	snapshot.set(
		".jarvis/context/docs/merge.md",
		"alpha\nsource slot\nmiddle one\nmiddle two\nsnapshot changed\nomega\n",
	);
	snapshot.set(".jarvis/context/docs/standards/ci-process.md", "snapshot CI policy\n");
	snapshot.set("tools/flow-install/lib/skills.mjs", "export const choice = 'snapshot';\n");
	snapshot.set(
		"jarvis-cli/src/jarvis/cli.py",
		'def _normalize_docs_default(value):\n    return value\n\ndef _generate_command_tree(cli, path):\n    return []\n\ndef _generate_docs() -> dict:\n    return {\n        "snapshot": True,\n    }\n\ndef _format_docs_markdown(value):\n    return value\n',
	);
	await createCompatibilityPackage(packageRoot, snapshot, provenanceFor({ base, overlays: [overlay] }));
	const resourcesBefore = await describeV1Tree(join(packageRoot, "resources"));
	const scratchBefore = await listReconciliationScratch();

	const firstDryRun = await reconcileV1Compatibility({
		sourceRoot,
		packageRoot,
		dryRun: true,
		snapshotBaseCommit: base,
		reconciliationBase: base,
		overlayCommits: [overlay],
	});
	assert.equal(firstDryRun.ok, true);
	assert.equal(firstDryRun.applied, false);
	assert.deepEqual(
		firstDryRun.deletions.map((entry) => entry.path),
		[
			".jarvis/context/docs/delete.md",
			".jarvis/context/docs/old-name.md",
			"tools/flow-install/dirty-old.txt",
		],
	);
	assert(firstDryRun.writes.some((entry) => entry.path === ".jarvis/context/docs/new-name.md"));
	assert(firstDryRun.writes.some((entry) => entry.path === "tools/flow-install/dirty-new.txt"));
	assert(firstDryRun.writes.some((entry) => entry.path === "jarvis-cli/untracked.txt"));
	assert(firstDryRun.unchanged.some((entry) => entry.path.endsWith("ci-process.md") && entry.decision === "keep-snapshot"));
	assert(firstDryRun.writes.some((entry) => entry.path.endsWith("skills.mjs") && entry.decision === "take-source"));
	assert(firstDryRun.writes.some((entry) => entry.path === ".gitignore" && entry.decision === "merge-gitignore"));
	assert(firstDryRun.writes.some((entry) => entry.path.endsWith("pyproject.toml") && entry.decision === "merge-pyproject"));
	assert(firstDryRun.writes.some((entry) => entry.path.endsWith("cli.py") && entry.decision === "merge-command-tree"));
	assert.equal(firstDryRun.selectedInputs.pathCount, firstDryRun.selected);
	assert(firstDryRun.selectedInputs.entries.some((entry) => entry.path.endsWith("old-name.md") && entry.state === "deleted"));
	assert.deepEqual(await listReconciliationScratch(), scratchBefore);
	await assertResourcesUnchanged(packageRoot, resourcesBefore);

	await writeFixtureFile(sourceRoot, "jarvis-cli/untracked.txt", "untracked version two\n");
	const secondDryRun = await reconcileV1Compatibility({
		sourceRoot,
		packageRoot,
		dryRun: true,
		snapshotBaseCommit: base,
		reconciliationBase: base,
		overlayCommits: [overlay],
	});
	assert.notEqual(firstDryRun.dirtyInput.digest, secondDryRun.dirtyInput.digest);
	assert.notEqual(
		firstDryRun.dirtyInput.untrackedInputs.digest,
		secondDryRun.dirtyInput.untrackedInputs.digest,
	);
	assert.equal(firstDryRun.dirtyInput.trackedPatchSha256, secondDryRun.dirtyInput.trackedPatchSha256);
	assert.equal(firstDryRun.provenance.dirtyPatchSha256, firstDryRun.dirtyInput.trackedPatchSha256);
	assert.equal(secondDryRun.provenance.dirtyPatchSha256, secondDryRun.dirtyInput.trackedPatchSha256);
	await assertResourcesUnchanged(packageRoot, resourcesBefore);

	const applied = await reconcileV1Compatibility({
		sourceRoot,
		packageRoot,
		snapshotBaseCommit: base,
		reconciliationBase: base,
		overlayCommits: [overlay],
	});
	assert.equal(applied.ok, true);
	assert.equal(applied.applied, true);
	for (const path of [
		".jarvis/context/docs/delete.md",
		".jarvis/context/docs/old-name.md",
		"tools/flow-install/dirty-old.txt",
	])
		await assert.rejects(readFile(join(packageRoot, "resources/source", path)));
	assert.equal(
		await readFile(join(packageRoot, "resources/source/.jarvis/context/docs/new-name.md"), "utf8"),
		"renamed content\n",
	);
	assert.equal(
		await readFile(join(packageRoot, "resources/source/tools/flow-install/dirty-new.txt"), "utf8"),
		"dirty rename\n",
	);
	assert.equal(
		await readFile(join(packageRoot, "resources/source/jarvis-cli/untracked.txt"), "utf8"),
		"untracked version two\n",
	);
	assert.equal(
		await readFile(join(packageRoot, "resources/source/.jarvis/context/docs/merge.md"), "utf8"),
		"alpha\nsource changed\nmiddle one\nmiddle two\nsnapshot changed\nomega\n",
	);
	assert.equal(
		await readFile(join(packageRoot, "resources/source/.jarvis/context/docs/standards/ci-process.md"), "utf8"),
		"snapshot CI policy\n",
	);
	assert.equal(
		await readFile(join(packageRoot, "resources/source/tools/flow-install/lib/skills.mjs"), "utf8"),
		"export const choice = 'source';\n",
	);
	assert.equal(
		await readFile(join(packageRoot, "resources/source/.gitignore"), "utf8"),
		".jarvis/context/deployments/\n.jarvis/context/evidence/\n",
	);
	const pyproject = await readFile(join(packageRoot, "resources/source/jarvis-cli/pyproject.toml"), "utf8");
	assert(pyproject.includes('"markdown-it-py>=3.0.0"'));
	assert(!pyproject.includes("source-only"));
	const cli = await readFile(join(packageRoot, "resources/source/jarvis-cli/src/jarvis/cli.py"), "utf8");
	assert(cli.includes("def _normalize_docs_default"));
	assert(cli.includes('"source": True'));
	assert(cli.includes('documentation["command_tree"]'));
	assert(!cli.includes('"snapshot": True'));
	await assert.rejects(readFile(join(packageRoot, "resources/context-vault/docs/delete.md")));
	await assert.rejects(readFile(join(packageRoot, "resources/flow-install/dirty-old.txt")));
	const verification = await verifyV1Compatibility(packageRoot);
	assert.equal(verification.ok, true, verification.issues.join("\n"));
	assert.equal(verification.provenance.schemaVersion, 2);
	assert.equal(
		verification.provenance.source.dirtyPatchSha256,
		applied.dirtyInput.trackedPatchSha256,
	);
	assert.equal(verification.provenance.source.selectedInputs.pathCount, applied.selected);

	verification.provenance.source.selectedInputs.entries[0].sha256 = "0".repeat(64);
	await writeFile(
		join(packageRoot, "resources/SOURCE.json"),
		`${JSON.stringify(verification.provenance, null, 2)}\n`,
	);
	const tampered = await verifyV1Compatibility(packageRoot);
	assert.equal(tampered.ok, false);
	assert(tampered.issues.includes("selected-inputs-digest-mismatch"));
});

test("multiple three-way conflict regions fail before any authoritative file changes", async (t) => {
	const { sourceRoot, packageRoot } = await makeTemporaryRoots(t);
	const baseline = requiredFiles();
	baseline.set(
		".jarvis/context/docs/conflict.md",
		"alpha\nshared one\nmiddle 1\nmiddle 2\nmiddle 3\nmiddle 4\nmiddle 5\nmiddle 6\nmiddle 7\nmiddle 8\nshared two\nomega\n",
	);
	baseline.set(".jarvis/context/docs/delete-conflict.md", "shared deletion\n");
	const base = await initializeRepository(sourceRoot, baseline);
	await writeFixtureFile(
		sourceRoot,
		".jarvis/context/docs/conflict.md",
		"alpha\nsource one\nmiddle 1\nmiddle 2\nmiddle 3\nmiddle 4\nmiddle 5\nmiddle 6\nmiddle 7\nmiddle 8\nsource two\nomega\n",
	);
	runGit(sourceRoot, ["rm", "-q", "--", ".jarvis/context/docs/delete-conflict.md"]);
	const overlay = commitPaths(sourceRoot, [".jarvis/context/docs/conflict.md"], "source conflict");
	const snapshot = new Map(baseline);
	snapshot.set(
		".jarvis/context/docs/conflict.md",
		"alpha\nsnapshot one\nmiddle 1\nmiddle 2\nmiddle 3\nmiddle 4\nmiddle 5\nmiddle 6\nmiddle 7\nmiddle 8\nsnapshot two\nomega\n",
	);
	snapshot.set(".jarvis/context/docs/delete-conflict.md", "snapshot changed deletion\n");
	await createCompatibilityPackage(packageRoot, snapshot, provenanceFor({ base, overlays: [overlay] }));
	const before = await describeV1Tree(join(packageRoot, "resources"));

	await assert.rejects(
		reconcileV1Compatibility({
			sourceRoot,
			packageRoot,
			snapshotBaseCommit: base,
			reconciliationBase: base,
			overlayCommits: [overlay],
		}),
		(error) => {
			assert(error instanceof V1ReconciliationError);
			assert(error.report.conflicts.some((conflict) => conflict.includes("three-way merge conflict (2 conflict regions)")));
			assert(error.report.conflicts.some((conflict) => conflict.includes("source deletion conflicts")));
			return true;
		},
	);
	await assertResourcesUnchanged(packageRoot, before);
});

test("deletion policies distinguish retained, source-owned, absent, and independently added paths", async (t) => {
	const { sourceRoot, packageRoot } = await makeTemporaryRoots(t);
	const baseline = requiredFiles();
	baseline.set(".jarvis/context/docs/standards/ci-process.md", "keep this snapshot\n");
	baseline.set("tools/flow-install/lib/skills.mjs", "delete with source policy\n");
	const base = await initializeRepository(sourceRoot, baseline);
	await writeFixtureFile(sourceRoot, ".jarvis/context/docs/ephemeral.md", "temporary\n");
	await writeFixtureFile(sourceRoot, ".jarvis/context/docs/deleted-independent.md", "source temporary\n");
	await writeFixtureFile(sourceRoot, ".jarvis/context/docs/source-added.md", "source addition\n");
	await writeFixtureFile(sourceRoot, "jarvis-cli/base.txt", "temporary overlay value\n");
	const overlayOne = commitPaths(
		sourceRoot,
		[
			".jarvis/context/docs/deleted-independent.md",
			".jarvis/context/docs/ephemeral.md",
			".jarvis/context/docs/source-added.md",
			"jarvis-cli/base.txt",
		],
		"add source paths",
	);
	runGit(sourceRoot, [
		"rm",
		"-q",
		"--",
		".jarvis/context/docs/deleted-independent.md",
		".jarvis/context/docs/ephemeral.md",
		".jarvis/context/docs/standards/ci-process.md",
		"tools/flow-install/lib/skills.mjs",
	]);
	await writeFixtureFile(sourceRoot, "jarvis-cli/base.txt", "jarvis baseline\n");
	const overlayTwo = commitPaths(sourceRoot, ["jarvis-cli/base.txt"], "delete source paths", "2026-01-03T00:00:00Z");
	const snapshot = new Map(baseline);
	snapshot.set(".jarvis/context/docs/deleted-independent.md", "independent snapshot deletion target\n");
	snapshot.set(".jarvis/context/docs/source-added.md", "independent snapshot addition\n");
	await createCompatibilityPackage(
		packageRoot,
		snapshot,
		provenanceFor({ base, overlays: [overlayOne, overlayTwo] }),
	);
	const before = await describeV1Tree(join(packageRoot, "resources"));

	await assert.rejects(
		reconcileV1Compatibility({
			sourceRoot,
			packageRoot,
			snapshotBaseCommit: base,
			reconciliationBase: base,
			overlayCommits: [overlayOne, overlayTwo],
		}),
		(error) => {
			assert(error instanceof V1ReconciliationError);
			assert(
				error.report.unchanged.some(
					(entry) => entry.path.endsWith("ci-process.md") && entry.decision === "keep-snapshot",
				),
			);
			assert(error.report.unchanged.some((entry) => entry.path.endsWith("ephemeral.md") && entry.decision === "already-absent"));
			assert(error.report.unchanged.some((entry) => entry.path === "jarvis-cli/base.txt" && entry.decision === "identical"));
			assert(
				error.report.deletions.some(
					(entry) => entry.path.endsWith("skills.mjs") && entry.decision === "take-source-deletion",
				),
			);
			assert(error.report.conflicts.some((issue) => issue.includes("deleted from source but added independently")));
			assert(error.report.conflicts.some((issue) => issue.includes("added independently in both snapshots")));
			return true;
		},
	);
	await assertResourcesUnchanged(packageRoot, before);
});

test("a rejected dirty path is a preflight error and leaves the pack unchanged", async (t) => {
	const { sourceRoot, packageRoot } = await makeTemporaryRoots(t);
	const baseline = requiredFiles();
	const base = await initializeRepository(sourceRoot, baseline);
	await writeFixtureFile(sourceRoot, "jarvis-cli/base.txt", "overlay jarvis\n");
	const overlay = commitPaths(sourceRoot, ["jarvis-cli/base.txt"], "fixture overlay");
	await writeFixtureFile(sourceRoot, "projects/rejected.txt", "must not export\n");
	await symlink("base.txt", join(sourceRoot, "jarvis-cli/link.txt"));
	await createCompatibilityPackage(packageRoot, baseline, provenanceFor({ base, overlays: [overlay] }));
	const before = await describeV1Tree(join(packageRoot, "resources"));

	await assert.rejects(
		reconcileV1Compatibility({
			sourceRoot,
			packageRoot,
			snapshotBaseCommit: base,
			reconciliationBase: base,
			overlayCommits: [overlay],
		}),
		(error) => {
			assert(error instanceof V1ReconciliationError);
			assert(error.report.rejectedDirtyPaths.includes("projects/rejected.txt"));
			assert(error.report.unsafeInputs.some((issue) => issue.includes("jarvis-cli/link.txt")));
			return true;
		},
	);
	await assertResourcesUnchanged(packageRoot, before);
});

test("candidate privacy rejection cannot partially update the authoritative pack", async (t) => {
	const { sourceRoot, packageRoot } = await makeTemporaryRoots(t);
	const baseline = requiredFiles();
	const base = await initializeRepository(sourceRoot, baseline);
	await writeFixtureFile(sourceRoot, "jarvis-cli/base.txt", "overlay jarvis\n");
	const overlay = commitPaths(sourceRoot, ["jarvis-cli/base.txt"], "fixture overlay");
	await writeFixtureFile(sourceRoot, ".jarvis/context/docs/private/secret.md", "private candidate\n");
	await createCompatibilityPackage(packageRoot, baseline, provenanceFor({ base, overlays: [overlay] }));
	const before = await describeV1Tree(join(packageRoot, "resources"));

	await assert.rejects(
		reconcileV1Compatibility({
			sourceRoot,
			packageRoot,
			snapshotBaseCommit: base,
			reconciliationBase: base,
			overlayCommits: [overlay],
		}),
		(error) => error instanceof V1ReconciliationError && error.message.includes("private-context"),
	);
	await assertResourcesUnchanged(packageRoot, before);
	await assert.rejects(
		readFile(join(packageRoot, "resources/source/.jarvis/context/docs/private/secret.md")),
	);
});

test("invalid overlay ancestry and starting snapshot drift both fail closed", async (t) => {
	const { sourceRoot, packageRoot } = await makeTemporaryRoots(t);
	const baseline = requiredFiles();
	const base = await initializeRepository(sourceRoot, baseline);
	await writeFixtureFile(sourceRoot, "jarvis-cli/base.txt", "overlay one\n");
	const overlayOne = commitPaths(sourceRoot, ["jarvis-cli/base.txt"], "overlay one", "2026-01-02T00:00:00Z");
	await writeFixtureFile(sourceRoot, "jarvis-cli/base.txt", "overlay two\n");
	const overlayTwo = commitPaths(sourceRoot, ["jarvis-cli/base.txt"], "overlay two", "2026-01-03T00:00:00Z");
	await createCompatibilityPackage(
		packageRoot,
		baseline,
		provenanceFor({ base, overlays: [overlayTwo, overlayOne], head: overlayTwo }),
	);
	const before = await describeV1Tree(join(packageRoot, "resources"));

	await assert.rejects(
		reconcileV1Compatibility({
			sourceRoot,
			packageRoot,
			snapshotBaseCommit: base,
			reconciliationBase: base,
			overlayCommits: [overlayTwo, overlayOne],
		}),
		/not an ancestor/,
	);
	await assertResourcesUnchanged(packageRoot, before);

	const sourceFile = join(packageRoot, "resources/source/jarvis-cli/base.txt");
	await writeFile(sourceFile, "drifted snapshot\n");
	await assert.rejects(
		reconcileV1Compatibility({
			sourceRoot,
			packageRoot,
			snapshotBaseCommit: base,
			reconciliationBase: base,
			overlayCommits: [overlayTwo, overlayOne],
		}),
		/Starting compatibility snapshot is invalid/,
	);
});

test("the verified starting tree must declare the configured snapshot base", async (t) => {
	const { sourceRoot, packageRoot } = await makeTemporaryRoots(t);
	const baseline = requiredFiles();
	const base = await initializeRepository(sourceRoot, baseline);
	await writeFixtureFile(sourceRoot, "jarvis-cli/base.txt", "overlay jarvis\n");
	const overlay = commitPaths(sourceRoot, ["jarvis-cli/base.txt"], "fixture overlay");
	await createCompatibilityPackage(packageRoot, baseline, {
		...provenanceFor({ base, overlays: [overlay] }),
		snapshotBaseCommit: overlay,
	});
	const before = await describeV1Tree(join(packageRoot, "resources"));

	await assert.rejects(
		reconcileV1Compatibility({
			sourceRoot,
			packageRoot,
			snapshotBaseCommit: base,
			reconciliationBase: base,
			overlayCommits: [overlay],
		}),
		/Starting snapshot snapshotBaseCommit does not match/,
	);
	await assertResourcesUnchanged(packageRoot, before);
});

test("a zero-overlay dirty export validates the base and remains non-mutating in dry-run", async (t) => {
	const { sourceRoot, packageRoot } = await makeTemporaryRoots(t);
	const baseline = requiredFiles();
	const base = await initializeRepository(sourceRoot, baseline);
	await writeFixtureFile(sourceRoot, "jarvis-cli/untracked.txt", "dirty input\n");
	await writeFixtureFile(sourceRoot, ".jarvis/context/projects.md", "excluded private inventory\n");
	await createCompatibilityPackage(packageRoot, baseline, provenanceFor({ base, overlays: [] }));
	const before = await describeV1Tree(join(packageRoot, "resources"));
	const scratchBefore = await listReconciliationScratch();

	const report = await reconcileV1Compatibility({
		sourceRoot,
		packageRoot,
		dryRun: true,
		snapshotBaseCommit: base,
		reconciliationBase: base,
		overlayCommits: [],
	});
	assert.equal(report.ok, true);
	assert.equal(report.sourceStable, true);
	assert(report.writes.some((entry) => entry.path === "jarvis-cli/untracked.txt"));
	assert.deepEqual(report.reviewedExclusions, [classifyReviewedV1Exclusion(".jarvis/context/projects.md")]);
	assert.deepEqual(report.provenance.reviewedExclusions, report.reviewedExclusions);
	assert(!report.dirtyInput.untrackedInputs.entries.some(({ path }) => path === ".jarvis/context/projects.md"));
	assert.deepEqual(await listReconciliationScratch(), scratchBefore);
	await assertResourcesUnchanged(packageRoot, before);

	await assert.rejects(
		reconcileV1Compatibility({
			sourceRoot: join(sourceRoot, "jarvis-cli"),
			packageRoot,
			dryRun: true,
			snapshotBaseCommit: base,
			reconciliationBase: base,
			overlayCommits: [],
		}),
		/--source must be a repository root/,
	);
	await assert.rejects(
		reconcileV1Compatibility({
			sourceRoot,
			packageRoot,
			dryRun: true,
			snapshotBaseCommit: "missing-commit",
			reconciliationBase: base,
			overlayCommits: [],
		}),
		/fatal: Needed a single revision/,
	);
});

test("a file-to-directory collision and a binary merge error both preserve the pack", async (t) => {
	const first = await makeTemporaryRoots(t);
	const collisionSource = requiredFiles();
	collisionSource.set("jarvis-cli/collision", "source file\n");
	const collisionBase = await initializeRepository(first.sourceRoot, collisionSource);
	await writeFixtureFile(first.sourceRoot, "jarvis-cli/collision", "changed source file\n");
	const collisionOverlay = commitPaths(first.sourceRoot, ["jarvis-cli/collision"], "collision overlay");
	const collisionSnapshot = requiredFiles();
	collisionSnapshot.set("jarvis-cli/collision/nested.txt", "snapshot directory\n");
	await createCompatibilityPackage(
		first.packageRoot,
		collisionSnapshot,
		provenanceFor({ base: collisionBase, overlays: [collisionOverlay] }),
	);
	const collisionBefore = await describeV1Tree(join(first.packageRoot, "resources"));
	await assert.rejects(
		reconcileV1Compatibility({
			sourceRoot: first.sourceRoot,
			packageRoot: first.packageRoot,
			snapshotBaseCommit: collisionBase,
			reconciliationBase: collisionBase,
			overlayCommits: [collisionOverlay],
		}),
		(error) =>
			error instanceof V1ReconciliationError &&
			error.report.conflicts.some((issue) => issue.includes("snapshot target is not a regular file")),
	);
	await assertResourcesUnchanged(first.packageRoot, collisionBefore);

	const second = await makeTemporaryRoots(t);
	const binarySource = requiredFiles();
	binarySource.set("jarvis-cli/binary.bin", Buffer.from([0, 1, 2, 3]));
	const binaryBase = await initializeRepository(second.sourceRoot, binarySource);
	await writeFixtureFile(second.sourceRoot, "jarvis-cli/binary.bin", Buffer.from([0, 1, 2, 4]));
	const binaryOverlay = commitPaths(second.sourceRoot, ["jarvis-cli/binary.bin"], "binary overlay");
	const binarySnapshot = new Map(binarySource);
	binarySnapshot.set("jarvis-cli/binary.bin", Buffer.from([0, 1, 2, 5]));
	await createCompatibilityPackage(
		second.packageRoot,
		binarySnapshot,
		provenanceFor({ base: binaryBase, overlays: [binaryOverlay] }),
	);
	const binaryBefore = await describeV1Tree(join(second.packageRoot, "resources"));
	await assert.rejects(
		reconcileV1Compatibility({
			sourceRoot: second.sourceRoot,
			packageRoot: second.packageRoot,
			snapshotBaseCommit: binaryBase,
			reconciliationBase: binaryBase,
			overlayCommits: [binaryOverlay],
		}),
		/Cannot merge binary files/,
	);
	await assertResourcesUnchanged(second.packageRoot, binaryBefore);
});
