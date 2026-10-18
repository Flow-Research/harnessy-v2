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

const commandLinesFor = (job) =>
	commandsFor(job)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

// The aggregate job keeps the historical required check name; the gates themselves run
// in the parallel jobs it needs.
export const harnessyAggregateJob = "build-check-test";
export const harnessyGateCommands = [
	"npm run build",
	"npm run verify:v1-compatibility",
	"npm run check",
	"npm run qa:check",
	"npm run test:qa-contract",
	"npm run test:qa-scenarios",
	"npm run test:sdk-fixture",
	"npm run test:local-host-fixture",
	"./test.sh",
	"npm run test:coverage",
	"npm run test:engine-fixture",
	"npm run test:executor-package-contract",
	"npm run test:release-artifacts:installed-local-host",
	"npm run test:release-artifacts:installed-product",
];
const releaseArtifactCommands = [
	"npm run test:release-artifacts",
	"npm run test:release-artifacts:installed-local-host",
	"npm run test:release-artifacts:installed-product",
];
const generatorCommands = [...harnessyGateCommands, ...releaseArtifactCommands];

const validateHarnessyGateJobs = (issues, ci) => {
	const aggregate = ci.jobs[harnessyAggregateJob];
	if (aggregate === undefined) {
		issues.push(`CI must define the ${harnessyAggregateJob} aggregate job`);
		return;
	}
	const gateJobs = normalizeNeeds(aggregate.needs);
	if (gateJobs.length === 0) issues.push(`CI:${harnessyAggregateJob} must need every Harnessy gate job`);
	if (!String(aggregate.if ?? "").includes("always()")) {
		issues.push(`CI:${harnessyAggregateJob} must run with always() so failed or skipped gate jobs fail it`);
	}
	// The verdict must be an exit-status check (jq -e) on one command line, with nothing that
	// can swallow its failure: no "|| true", no continue-on-error on the step or the job.
	const isVerdictLine = (line) =>
		/^echo "\$NEEDS_JSON" \| jq -e '[^']*all\(\.value\.result == "success"\)[^']*'( > \/dev\/null)?$/u.test(line);
	const verdict = (aggregate.steps ?? []).find((step) =>
		Object.values(step.env ?? {}).some((value) => String(value).includes("toJSON(needs)")),
	);
	if (
		verdict !== undefined &&
		(String(verdict.run ?? "").includes("||") ||
			String(verdict["continue-on-error"] ?? "false") !== "false" ||
			String(aggregate["continue-on-error"] ?? "false") !== "false")
	) {
		issues.push(`CI:${harnessyAggregateJob} must not ignore a failed verdict (no ||, no continue-on-error)`);
	} else if (verdict === undefined || !commandLinesFor({ steps: [verdict] }).some(isVerdictLine)) {
		issues.push(`CI:${harnessyAggregateJob} must fail unless every needed job result is success (jq -e on NEEDS_JSON)`);
	}
	if (commandLinesFor(aggregate).some((line) => generatorCommands.includes(line))) {
		issues.push(`CI:${harnessyAggregateJob} must only aggregate gate job results`);
	}
	for (const jobId of gateJobs) {
		if (ci.jobs[jobId] === undefined) issues.push(`CI:${harnessyAggregateJob} needs unknown job ${jobId}`);
	}

	const jobsRunning = (command) => gateJobs.filter((jobId) => commandLinesFor(ci.jobs[jobId]).includes(command));
	for (const command of harnessyGateCommands) {
		if (jobsRunning(command).length === 0) issues.push(`CI:${harnessyAggregateJob} gate jobs must run ${command}`);
	}

	const buildJobs = jobsRunning("npm run build");
	const buildJob = buildJobs[0];
	if (buildJobs.length > 1) issues.push("CI Harnessy gate jobs must share one build job");
	const buildUpload = (ci.jobs[buildJob]?.steps ?? []).find((step) =>
		String(step.uses ?? "").startsWith("actions/upload-artifact@"),
	);
	const buildArtifact = String(buildUpload?.with?.name ?? "");
	if (buildJob !== undefined && buildArtifact === "") issues.push(`CI:${buildJob} must upload the shared build outputs`);
	// "Re-run failed jobs" does not re-run a successful build, so gate jobs in a later attempt
	// must find the first attempt's artifact; a re-run build replaces it.
	if (buildArtifact.includes("run_attempt")) {
		issues.push(`CI:${buildJob} build artifact name must not include github.run_attempt`);
	}
	if (buildUpload !== undefined && String(buildUpload.with?.overwrite) !== "true") {
		issues.push(`CI:${buildJob} build artifact upload must set overwrite: true`);
	}
	for (const jobId of gateJobs.filter((candidate) => candidate !== buildJob)) {
		if (!normalizeNeeds(ci.jobs[jobId]?.needs).includes(buildJob)) {
			issues.push(`CI:${jobId} must need the shared build job ${String(buildJob)}`);
		}
		const restoresBuild = (ci.jobs[jobId]?.steps ?? []).some((step) => step.with?.["build-artifact"] === buildArtifact);
		if (buildArtifact !== "" && !restoresBuild) issues.push(`CI:${jobId} must restore the shared build outputs`);
	}

	// Every gate job, and every other job that runs a packed release part, must prove it
	// left tracked files unchanged and produced no tracked or untracked output.
	for (const [jobId, job] of Object.entries(ci.jobs)) {
		const lines = commandLinesFor(job);
		if (!gateJobs.includes(jobId) && !lines.some((line) => releaseArtifactCommands.includes(line))) continue;
		const lastGenerator = Math.max(...lines.map((line, index) => (generatorCommands.includes(line) ? index : -1)));
		if (lastGenerator < 0) continue;
		for (const check of ["git diff --exit-code", "npm run check:clean-worktree"]) {
			if (lines.lastIndexOf(check) < lastGenerator) {
				issues.push(`CI:${jobId} must run ${check} after ${lines[lastGenerator]}`);
			}
		}
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

	validateHarnessyGateJobs(issues, ci);
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
	requireCommand(issues, "Security Gates", security, "root-dependencies-and-invariants", "node scripts/audit-root.mjs --json");
	requireCommand(issues, "Security Gates", security, "root-dependencies-and-invariants", "node scripts/check-security-invariants.mjs");
	requireCommand(issues, "Security Gates", security, "executor-dependencies", "node scripts/audit-executor.mjs --json");

	if (!release.jobs["release-preflight"]) issues.push("Build Binaries must define release-preflight");
	requireCommand(issues, "Build Binaries", release, "release-preflight", "npm run release:preflight");
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
	requireCommand(issues, "Build Binaries", release, "publish-npm", "npm run supply-chain:generate");
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
	const profileReleaseParts = [
		"npm run test:release-artifacts:installed-local-host",
		"npm run test:release-artifacts:installed-product",
	];
	for (const command of ["npm run test:local-host-fixture", ...profileReleaseParts, "npm run check:clean-worktree"]) {
		if (!packedProfileCommands.includes(command)) {
			issues.push(`CI profile packed consumer gate must run ${command}`);
		}
	}
	for (const command of profileReleaseParts) {
		if (packedProfileCommands.lastIndexOf("npm run check:clean-worktree") < packedProfileCommands.indexOf(command)) {
			issues.push(`CI profile packed consumer gate must run npm run check:clean-worktree after ${command}`);
		}
	}

	const declaredChecks = new Set(profile.remote?.requiredCheckNames ?? []);
	const expectedChecks = [
		`${ci.name} / ${ci.jobs["build-check-test"]?.name}`,
		`${ci.name} / ${ci.jobs.executor?.name}`,
		`${ci.name} / ${ci.jobs["supply-chain"]?.name}`,
		...((ci.jobs["packaged-executor"]?.strategy?.matrix?.os ?? []).map(
			(os) => `${ci.name} / Packaged Executor (${os})`,
		)),
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
