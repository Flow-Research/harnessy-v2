import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// The host's operational entrypoints use these Core dependencies, not the
// interactive CLI's agent binaries. Core bytes and manifests remain unchanged.
// The installed-consumer gate must exercise this layout, not an npm .bin tree.
const CORE_SERVICE_DEPENDENCIES = Object.freeze(["effect", "marked"]);
const ROOT_PACKAGES = Object.freeze(["@harnessy/core", "@harnessy/sdk", "@harnessy/local-host"]);

/** Stage an inert service tree within a release; never install or activate it. */
export function stageLocalServiceRuntime(installedModules, destination) {
	const sourceRoot = realpathSync(installedModules);
	const requestedTarget = resolve(destination);
	const targetRoot = join(realpathSync(dirname(requestedTarget)), basename(requestedTarget));
	const inside = (parent, child) => {
		const path = relative(parent, child);
		return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
	};
	if (inside(sourceRoot, targetRoot) || inside(targetRoot, sourceRoot)) {
		throw new Error("Service staging destination must be separate from the installed modules");
	}
	if (existsSync(targetRoot)) throw new Error("Service staging destination already exists");
	const copied = new Set();
	const singletonRoots = new Map();
	const locate = (name, from, optional) => {
		const paths = createRequire(join(from, "package.json")).resolve.paths(name) ?? [];
		for (const modules of paths) {
			const candidate = join(modules, name);
			if (!existsSync(join(candidate, "package.json"))) continue;
			if (!inside(sourceRoot, candidate) || realpathSync(candidate) !== candidate) {
				throw new Error(`Service dependency escapes the installed artifact: ${name}`);
			}
			return candidate;
		}
		if (optional) return undefined;
		throw new Error(`Missing installed service dependency: ${name}`);
	};
	const copyPackage = (name, source) => {
		if (copied.has(source)) return;
		const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
		if (manifest.name !== name) throw new Error(`Installed service dependency identity mismatch: ${name}`);
		if (name === "effect" || name === "@harnessy/core") {
			if (singletonRoots.has(name) && singletonRoots.get(name) !== source) {
				throw new Error(`Service artifact must resolve one ${name === "effect" ? "Effect" : "Core"} runtime`);
			}
			singletonRoots.set(name, source);
		}
		copied.add(source);
		const target = join(targetRoot, "node_modules", relative(sourceRoot, source));
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		cpSync(source, target, {
			recursive: true,
			filter: (path) => {
				// Recreate nested dependencies from the actual resolution graph below.
				if (path === join(source, "node_modules")) return false;
				const stat = lstatSync(path);
				if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.mode & 0o022) !== 0) {
					throw new Error(`Unsafe installed service package entry: ${relative(sourceRoot, path)}`);
				}
				return true;
			},
		});
		const required = name === "@harnessy/core"
			? Object.fromEntries(CORE_SERVICE_DEPENDENCIES.map((dependency) => {
				if (!manifest.dependencies?.[dependency]) throw new Error(`Core service dependency is undeclared: ${dependency}`);
				return [dependency, manifest.dependencies[dependency]];
			}))
			: manifest.dependencies ?? {};
		const optional = name === "@harnessy/core" ? {} : manifest.optionalDependencies ?? {};
		for (const dependency of Object.keys({ ...required, ...optional }).sort()) {
			const dependencyRoot = locate(dependency, source, Object.hasOwn(optional, dependency));
			if (dependencyRoot !== undefined) copyPackage(dependency, dependencyRoot);
		}
	};
	// Exclusive creation: errors only remove the directory created by this call.
	mkdirSync(targetRoot, { mode: 0o700 });
	try {
		for (const name of ROOT_PACKAGES) copyPackage(name, locate(name, dirname(sourceRoot), false));
		return { root: targetRoot, packages: [...copied].map((path) => relative(sourceRoot, path)).sort() };
	} catch (error) {
		rmSync(targetRoot, { recursive: true, force: true });
		throw error;
	}
}
