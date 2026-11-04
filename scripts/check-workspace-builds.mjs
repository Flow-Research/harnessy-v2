import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const rootBuild = rootPackage.scripts?.build;

if (typeof rootBuild !== "string") {
	console.error("Root package.json must define scripts.build.");
	process.exit(1);
}

const workspacePackagePaths = [];
for (const workspace of rootPackage.workspaces ?? []) {
	if (workspace === "packages/*") {
		for (const entry of readdirSync("packages", { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const packagePath = join("packages", entry.name, "package.json");
			if (existsSync(packagePath)) workspacePackagePaths.push(packagePath);
		}
		continue;
	}

	const packagePath = join(workspace, "package.json");
	if (existsSync(packagePath)) workspacePackagePaths.push(packagePath);
}

const failures = [];
for (const packagePath of workspacePackagePaths.sort()) {
	if (!/^packages\/[^/]+\/package\.json$/.test(packagePath)) continue;

	const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
	if (typeof packageJson.scripts?.build !== "string") continue;

	const workspaceFlag = `--workspace ${packageJson.name}`;
	const workspaceEqualsFlag = `--workspace=${packageJson.name}`;
	if (rootBuild.includes(workspaceFlag) || rootBuild.includes(workspaceEqualsFlag)) continue;

	failures.push(`${packagePath}: buildable workspace ${packageJson.name} is missing from root scripts.build`);
}

if (/--workspace(?:=| )@earendil-works\/pi-ai run build(?:\s|$)/.test(rootBuild)) {
	failures.push("package.json: root scripts.build must use @earendil-works/pi-ai build:ts, not build; build regenerates live model metadata");
}

if (failures.length > 0) {
	console.error("Root build script must build every workspace with a build script:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
