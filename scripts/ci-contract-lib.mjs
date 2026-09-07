import { JSON_SCHEMA, load } from "js-yaml";

const parseWorkflow = (name, source) => {
	const workflow = load(source, { schema: JSON_SCHEMA });
	if (!workflow || typeof workflow !== "object" || !workflow.jobs || typeof workflow.jobs !== "object") {
		throw new Error(`${name} is not a GitHub Actions workflow`);
	}
	return workflow;
};

const normalizeNeeds = (needs) => (Array.isArray(needs) ? needs : needs ? [needs] : []);

const commandsFor = (job) =>
	(job?.steps ?? [])
		.map((step) => step.run)
		.filter((command) => typeof command === "string")
		.join("\n");

const requireCommand = (issues, workflowName, workflow, jobId, command) => {
	if (!commandsFor(workflow.jobs[jobId]).includes(command)) {
		issues.push(`${workflowName}:${jobId} must run ${command}`);
	}
};

const requireCommandAfter = (issues, workflowName, workflow, jobId, later, earlier) => {
	const commands = commandsFor(workflow.jobs[jobId]);
	if (commands.lastIndexOf(later) < commands.indexOf(earlier) || commands.indexOf(earlier) < 0) {
		issues.push(`${workflowName}:${jobId} must run ${later} after ${earlier}`);
	}
};

const requireEvidenceUpload = (issues, workflowName, workflow, jobId) => {
	const upload = (workflow.jobs[jobId]?.steps ?? []).find((step) => String(step.uses ?? "").startsWith("actions/upload-artifact@"));
	if (upload === undefined || !String(upload.with?.name ?? "").includes("supply-chain") || upload.with?.path !== ".supply-chain-evidence/") {
		issues.push(`${workflowName}:${jobId} must upload .supply-chain-evidence with a supply-chain artifact name`);
	}
};

const requireEvidenceUploadBetween = (issues, workflowName, workflow, jobId, earlier, later) => {
	const steps = workflow.jobs[jobId]?.steps ?? [];
	const earlierIndex = steps.findIndex((step) => String(step.run ?? "").includes(earlier));
	const uploadIndex = steps.findIndex(
		(step) =>
			String(step.uses ?? "").startsWith("actions/upload-artifact@") &&
			String(step.with?.name ?? "").includes("supply-chain") &&
			step.with?.path === ".supply-chain-evidence/",
	);
	const laterIndex = steps.findIndex((step) => String(step.run ?? "").includes(later));
	if (earlierIndex < 0 || uploadIndex <= earlierIndex || laterIndex <= uploadIndex) {
		issues.push(`${workflowName}:${jobId} must upload .supply-chain-evidence after ${earlier} and before ${later}`);
	}
};

const requireBranches = (issues, workflowName, workflow, event) => {
	const branches = workflow.on?.[event]?.branches;
	for (const branch of ["main", "dev"]) {
		if (!Array.isArray(branches) || !branches.includes(branch)) {
			issues.push(`${workflowName} ${event} must include ${branch}`);
		}
	}
};

export const validateCiContract = ({ ciSource, securitySource, releaseSource, profile }) => {
	const ci = parseWorkflow("CI", ciSource);
	const security = parseWorkflow("Security Gates", securitySource);
	const release = parseWorkflow("Build Binaries", releaseSource);
	const issues = [];

	for (const [name, workflow] of [
		["CI", ci],
		["Security Gates", security],
	]) {
		requireBranches(issues, name, workflow, "push");
		requireBranches(issues, name, workflow, "pull_request");
	}

	for (const command of [
		"npm run build",
		"npm run check",
		"git diff --exit-code",
		"npm run qa:check",
		"npm run test:qa-contract",
		"npm run test:qa-scenarios",
		"npm run test:sdk-fixture",
		"npm run test:local-host-fixture",
		"./test.sh",
		"npm run test:coverage",
		"npm run test:engine-fixture",
		"npm run test:executor-package-contract",
		"npm run test:release-artifacts",
		"npm run check:clean-worktree",
	]) {
		requireCommand(issues, "CI", ci, "build-check-test", command);
	}
	requireCommandAfter(
		issues,
		"CI",
		ci,
		"build-check-test",
		"git diff --exit-code",
		"npm run test:local-host-fixture",
	);
	requireCommandAfter(
		issues,
		"CI",
		ci,
		"build-check-test",
		"npm run check:clean-worktree",
		"npm run test:release-artifacts",
	);
	requireCommand(issues, "CI", ci, "executor", "bun run ci");
	requireCommand(issues, "CI", ci, "supply-chain", "npm run test:supply-chain");
	requireCommand(issues, "CI", ci, "supply-chain", "npm run supply-chain:generate");
	requireCommand(issues, "CI", ci, "supply-chain", "npm run supply-chain:verify");
	requireCommand(issues, "CI", ci, "supply-chain", "npm run supply-chain:reproducibility");
	requireEvidenceUpload(issues, "CI", ci, "supply-chain");
	const packagedCommands = commandsFor(ci.jobs["packaged-executor"]).split("\n").map((line) => line.trim());
	for (const command of [
		"node --test scripts/harnessy-executor-package-lib.test.mjs",
		"npm run test:executor-package-integration",
	]) {
		if (!packagedCommands.includes(command)) issues.push(`CI:packaged-executor must run ${command}`);
	}
	requireCommand(issues, "CI", ci, "v1-compatibility", "./scripts/test-v1-compatibility.sh");
	requireCommand(issues, "Security Gates", security, "root-dependencies-and-invariants", "npm audit --audit-level=moderate");
	requireCommand(issues, "Security Gates", security, "root-dependencies-and-invariants", "node scripts/check-security-invariants.mjs");
	requireCommand(issues, "Security Gates", security, "executor-dependencies", "node scripts/audit-executor.mjs --json");

	if (!release.jobs["release-preflight"]) issues.push("Build Binaries must define release-preflight");
	requireCommand(issues, "Build Binaries", release, "release-preflight", "npm run release:preflight");
	requireCommand(issues, "Build Binaries", release, "release-preflight", "npm install -g npm@11.16.0 --ignore-scripts");
	requireEvidenceUpload(issues, "Build Binaries", release, "release-preflight");
	if (!normalizeNeeds(release.jobs["stage-github-release"]?.needs).includes("release-preflight")) {
		issues.push("Build Binaries:stage-github-release must need release-preflight");
	}
	if (!commandsFor(release.jobs["stage-github-release"]).includes("gh release create")) {
		issues.push("Build Binaries:stage-github-release must own draft release creation");
	}
	if (!normalizeNeeds(release.jobs["publish-npm"]?.needs).includes("stage-github-release")) {
		issues.push("Build Binaries:publish-npm must need stage-github-release");
	}
	requireCommandAfter(issues, "Build Binaries", release, "publish-npm", "npm run supply-chain:generate", "npm install -g npm@11.16.0 --ignore-scripts");
	requireCommandAfter(issues, "Build Binaries", release, "publish-npm", "npm run supply-chain:verify", "npm run supply-chain:generate");
	requireCommandAfter(issues, "Build Binaries", release, "publish-npm", "npm run supply-chain:reproducibility", "npm run supply-chain:verify");
	requireEvidenceUpload(issues, "Build Binaries", release, "publish-npm");
	requireEvidenceUploadBetween(
		issues,
		"Build Binaries",
		release,
		"publish-npm",
		"npm run supply-chain:reproducibility",
		"node scripts/publish.mjs",
	);
	requireCommandAfter(issues, "Build Binaries", release, "publish-npm", "node scripts/publish.mjs", "npm run supply-chain:generate");

	const packedProfileGate = (profile.gates ?? []).find((gate) => gate.name === "packed consumers and release contracts");
	const packedProfileCommands = packedProfileGate?.commands ?? [];
	for (const command of ["npm run test:local-host-fixture", "npm run test:release-artifacts", "npm run check:clean-worktree"]) {
		if (!packedProfileCommands.includes(command)) {
			issues.push(`CI profile packed consumer gate must run ${command}`);
		}
	}
	if (
		packedProfileCommands.indexOf("npm run check:clean-worktree") <
		packedProfileCommands.indexOf("npm run test:release-artifacts")
	) {
		issues.push("CI profile packed consumer gate must run npm run check:clean-worktree after npm run test:release-artifacts");
	}

	const declaredChecks = new Set(profile.remote?.requiredCheckNames ?? []);
	const expectedChecks = [
		`${ci.name} / ${ci.jobs["build-check-test"]?.name}`,
		`${ci.name} / ${ci.jobs.executor?.name}`,
		`${ci.name} / ${ci.jobs["supply-chain"]?.name}`,
		...((ci.jobs["packaged-executor"]?.strategy?.matrix?.os ?? []).map(
			(os) => `${ci.name} / Packaged Executor (${os})`,
		)),
		`${ci.name} / ${ci.jobs["v1-compatibility"]?.name}`,
		`${security.name} / ${security.jobs["root-dependencies-and-invariants"]?.name}`,
		`${security.name} / ${security.jobs["executor-dependencies"]?.name}`,
	];
	for (const check of expectedChecks) {
		if (!declaredChecks.has(check)) issues.push(`CI profile is missing required hosted check name: ${check}`);
	}
	for (const check of declaredChecks) {
		if (!expectedChecks.includes(check)) issues.push(`CI profile declares an unknown hosted check name: ${check}`);
	}

	return { ok: issues.length === 0, issues, expectedChecks };
};
