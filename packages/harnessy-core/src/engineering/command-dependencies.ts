import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRIES = ["effect", "@effect/platform-node", "zod"] as const;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const packageName = (name: string) => /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name);
const inside = (root: string, path: string) => {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
function active(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error("Command dependency custody cancelled");
}
async function bytes(path: string, signal?: AbortSignal, maximum = MAX_FILE): Promise<Buffer> {
	active(signal);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum)
			throw new Error("Command dependencies require bounded singly linked regular files");
		const chunks: Buffer[] = [];
		let total = 0;
		const buffer = Buffer.allocUnsafe(Math.min(65536, Math.max(4096, stat.size + 1)));
		for (;;) {
			active(signal);
			const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, maximum + 1 - total), null);
			active(signal);
			if (!bytesRead) return Buffer.concat(chunks, total);
			total += bytesRead;
			if (total > maximum) throw new Error("Command dependency file limit exceeded");
			chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
		}
	} finally {
		await file.close();
	}
}
interface Manifest {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}
interface Edge {
	readonly from: string;
	readonly name: string;
	readonly target: string | null;
	readonly optional: boolean;
}
interface Inventory {
	readonly roots: ReadonlyArray<string>;
	readonly edges: ReadonlyArray<Edge>;
}
async function resolvePackage(name: string, from: string, signal?: AbortSignal): Promise<string | null> {
	if (!packageName(name)) throw new Error("Unsupported command dependency package name");
	for (const base of createRequire(join(from, "package.json")).resolve.paths(name) ?? []) {
		active(signal);
		const path = join(base, name, "package.json");
		const stat = await lstat(path).catch((error: unknown) => {
			if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
			throw error;
		});
		if (stat !== null) {
			const root = await realpath(dirname(path));
			// Workspace dist has no source-bound build receipt in these profiles.
			if (!root.split(sep).includes("node_modules"))
				throw new Error("Workspace build dependencies are unsupported by direct command profiles");
			return root;
		}
	}
	return null;
}
async function inventory(from: string, signal?: AbortSignal): Promise<Inventory> {
	const pending: Array<{ from: string; name: string; optional: boolean }> = ENTRIES.map((name) => ({
		from,
		name,
		optional: false,
	}));
	const roots = new Set<string>();
	const edges: Edge[] = [];
	while (pending.length) {
		active(signal);
		if (edges.length >= 512) throw new Error("Command dependency edge limit exceeded");
		const edge = pending.shift();
		if (!edge) break;
		const target = await resolvePackage(edge.name, edge.from, signal);
		edges.push({ ...edge, target });
		if (target === null) {
			if (!edge.optional) throw new Error(`Required command dependency is unavailable: ${edge.name}`);
			continue;
		}
		if (roots.has(target)) continue;
		if (roots.size >= 64) throw new Error("Command dependency package limit exceeded");
		roots.add(target);
		const manifest = JSON.parse(
			(await bytes(join(target, "package.json"), signal, 1024 * 1024)).toString("utf8"),
		) as Manifest;
		if (manifest.name !== edge.name || typeof manifest.version !== "string")
			throw new Error("Invalid dependency identity");
		for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
			if (typeof version !== "string") throw new Error("Invalid dependency declaration");
			pending.push({ from: target, name, optional: name in (manifest.optionalDependencies ?? {}) });
		}
		for (const name of Object.keys(manifest.optionalDependencies ?? {}))
			if (!(name in (manifest.dependencies ?? {}))) pending.push({ from: target, name, optional: true });
		for (const name of Object.keys(manifest.peerDependencies ?? {}))
			pending.push({ from: target, name, optional: manifest.peerDependenciesMeta?.[name]?.optional === true });
	}
	return { roots: [...roots].sort(), edges };
}
async function fileIdentity(
	root: string,
	signal?: AbortSignal,
	copyTo?: string,
	maximumBytes = MAX_BYTES,
	maximumEntries = 20000,
): Promise<{ digest: string; entries: number; size: number }> {
	active(signal);
	if ((await realpath(root)) !== root) throw new Error("Command dependency root mapping changed");
	const paths: string[] = [];
	const directories: Array<{ path: string; mode: number }> = [];
	let entries = 0,
		size = 0;
	const pending = [root];
	while (pending.length) {
		active(signal);
		const directory = pending.pop();
		if (!directory) break;
		const directoryStat = await lstat(directory);
		if (!directoryStat.isDirectory() || (await realpath(directory)) !== directory)
			throw new Error("Dependency directory mapping changed");
		directories.push({ path: relative(root, directory), mode: directoryStat.mode & 0o777 });
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			active(signal);
			if (++entries > maximumEntries) throw new Error("Command dependency entry limit exceeded");
			if (entry.name === "node_modules" && directory === root) continue;
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error("Unexpected command dependency symlink");
			if (entry.isDirectory()) pending.push(path);
			else {
				if (
					!entry.isFile() ||
					/\.(node|dylib|dll|so|wasm)$/i.test(entry.name) ||
					/^(\.env(\..*)?|\.npmrc|\.yarnrc(\..*)?|.*\.pem|.*\.key)$/i.test(entry.name)
				)
					throw new Error("Native, sensitive, or special command dependencies are unsupported");
				paths.push(path);
			}
		}
	}
	paths.sort();
	const state = createHash("sha256");
	for (const directory of directories.sort((a, b) => a.path.localeCompare(b.path))) {
		active(signal);
		state.update(JSON.stringify(["directory", directory.path, directory.mode])).update("\0");
		if (copyTo) await mkdir(join(copyTo, directory.path), { recursive: true, mode: 0o700 });
	}
	for (let offset = 0; offset < paths.length; offset += 4) {
		active(signal);
		const batch = await Promise.all(
			paths
				.slice(offset, offset + 4)
				.map(async (path) => ({ path, data: await bytes(path, signal), mode: (await lstat(path)).mode & 0o777 })),
		);
		for (const { path, data, mode } of batch) {
			size += data.length;
			if (size > maximumBytes) throw new Error("Command dependency byte limit exceeded");
			const rel = relative(root, path);
			state.update(JSON.stringify([rel, mode, data.length, sha(data)])).update("\0");
			if (copyTo) {
				await mkdir(dirname(join(copyTo, rel)), { recursive: true, mode: 0o700 });
				await writeFile(join(copyTo, rel), data, { flag: "wx", mode: 0o600 });
				await chmod(join(copyTo, rel), mode);
			}
		}
	}
	if (copyTo)
		for (const directory of directories.reverse()) {
			active(signal);
			await chmod(join(copyTo, directory.path), directory.mode);
		}
	active(signal);
	return { digest: state.digest("hex"), entries, size };
}

type PackageImage = Awaited<ReturnType<typeof fileIdentity>>;
function normalizedGraph(graph: Inventory, context: string) {
	const ids = new Map<string, number>();
	const id = (root: string) => {
		let value = ids.get(root);
		if (value === undefined) {
			value = ids.size;
			ids.set(root, value);
		}
		return value;
	};
	const edges = graph.edges.map((edge) => ({
		from: edge.from === context ? -1 : id(edge.from),
		name: edge.name,
		target: edge.target === null ? null : id(edge.target),
		optional: edge.optional,
	}));
	if (ids.size !== graph.roots.length || graph.roots.some((root) => !ids.has(root)))
		throw new Error("Invalid closed dependency topology");
	return { edges, roots: [...ids.keys()] };
}
function graphFingerprint(graph: Inventory, context: string, images: ReadonlyMap<string, PackageImage>): string {
	const normalized = normalizedGraph(graph, context);
	let entries = 0,
		size = 0;
	const packages = normalized.roots.map((root) => {
		const image = images.get(root);
		if (!image) throw new Error("Missing complete dependency image");
		entries += image.entries;
		size += image.size;
		if (entries > 20000 || size > MAX_BYTES) throw new Error("Command dependency graph exceeded its limits");
		return image.digest;
	});
	return sha(JSON.stringify({ edges: normalized.edges, packages }));
}

export type CommandRuntimeLock = Readonly<{
	status: "observed" | "unavailable";
	layout: "owned-workspace" | "installed-package" | "unrecognized-workspace";
	layoutDigest: string;
	digest?: string;
}>;
async function optionalFile(path: string, signal?: AbortSignal): Promise<Buffer | null> {
	const stat = await lstat(path).catch((error: unknown) => {
		if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		throw error;
	});
	return stat === null ? null : bytes(path, signal);
}
async function runtimeLock(controller: string, signal?: AbortSignal): Promise<CommandRuntimeLock> {
	active(signal);
	const packageBytes = await bytes(join(controller, "package.json"), signal, 1024 * 1024);
	const packageMetadata = JSON.parse(packageBytes.toString("utf8"));
	if (packageMetadata.name !== "@harnessy/core") throw new Error("Unknown controller package identity");
	if (basename(controller) !== "harnessy-core" || basename(dirname(controller)) !== "packages")
		return Object.freeze({ status: "unavailable", layout: "installed-package", layoutDigest: sha(packageBytes) });
	const workspace = join(controller, "../..");
	const workspaceBytes = await optionalFile(join(workspace, "package.json"), signal);
	const metadata = workspaceBytes === null ? null : JSON.parse(workspaceBytes.toString("utf8"));
	const layoutDigest = sha(
		JSON.stringify({
			controller: sha(packageBytes),
			workspace: workspaceBytes === null ? null : sha(workspaceBytes),
		}),
	);
	if (
		metadata?.name !== "harnessy-v2" ||
		metadata?.private !== true ||
		!Array.isArray(metadata.workspaces) ||
		!metadata.workspaces.includes("packages/*")
	)
		return Object.freeze({ status: "unavailable", layout: "unrecognized-workspace", layoutDigest });
	const lockBytes = await optionalFile(join(workspace, "package-lock.json"), signal);
	if (lockBytes === null) return Object.freeze({ status: "unavailable", layout: "owned-workspace", layoutDigest });
	const lock = JSON.parse(lockBytes.toString("utf8"));
	if (
		lock.name !== metadata.name ||
		lock.packages?.[""]?.name !== metadata.name ||
		lock.packages?.["packages/harnessy-core"]?.name !== packageMetadata.name
	)
		throw new Error("Runtime lock does not identify the owned controller workspace");
	return Object.freeze({ status: "observed", layout: "owned-workspace", layoutDigest, digest: sha(lockBytes) });
}

/** A live controller capability. Persisted JSON cannot restore its custody checks. */
export interface CommandDependencyClosure {
	readonly root: string;
	readonly mappings: Readonly<Record<string, string>>;
	readonly digest: string;
	readonly runtimeLock: CommandRuntimeLock;
	readonly observe: () => Promise<string>;
}

export async function freezeCommandDependencies(
	sourceRoots: ReadonlyArray<string>,
	output: string,
	signal?: AbortSignal,
): Promise<CommandDependencyClosure> {
	active(signal);
	if (sourceRoots.length < 1 || sourceRoots.length > 2)
		throw new Error("Command custody requires the exact source roots");
	for (const root of sourceRoots) {
		active(signal);
		if (!isAbsolute(root) || (await realpath(root)) !== root || !(await lstat(root)).isDirectory())
			throw new Error("Command source roots require canonical directories");
	}
	const controller = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
	const initialRuntimeLock = await runtimeLock(controller, signal);
	const approved = await inventory(controller, signal);
	const entryRoots = approved.edges.filter((edge) => edge.from === controller);
	const sourceGraphs: Array<{ context: string; graph: Inventory; digest: string }> = [];
	const expectedTopology = JSON.stringify(normalizedGraph(approved, controller).edges);
	for (const source of new Set(sourceRoots)) {
		active(signal);
		const context = join(source, "packages/harnessy-core"),
			graph = await inventory(context, signal);
		if (JSON.stringify(normalizedGraph(graph, context).edges) !== expectedTopology)
			throw new Error("Source command dependency versions or instance topology differ from the controller");
		sourceGraphs.push({ context, graph, digest: sha(JSON.stringify(graph)) });
	}

	if (
		!isAbsolute(output) ||
		(await realpath(dirname(output))) !== dirname(output) ||
		sourceRoots.some((root) => inside(root, output) || inside(output, root))
	)
		throw new Error("Command dependency custody must be outside source roots without symlinks");
	const parent = await lstat(dirname(output));
	if ((parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.())
		throw new Error("Command dependency custody requires a private parent");
	await mkdir(output, { mode: 0o700 });
	return Promise.resolve()
		.then(async () => {
			const frozen = new Map(approved.roots.map((root, index) => [root, join(output, `package-${index}`)]));
			const original = new Map<string, string>();
			const originalImages = new Map<string, PackageImage>();
			let entries = 0,
				size = 0;
			for (const [root, target] of frozen) {
				active(signal);
				await mkdir(target, { mode: 0o700 });
				const result = await fileIdentity(root, signal, target, MAX_BYTES - size, 20000 - entries);
				entries += result.entries;
				size += result.size;
				if (entries > 20000 || size > MAX_BYTES) throw new Error("Command dependency closure limit exceeded");
				original.set(root, result.digest);
				originalImages.set(root, result);
			}
			const links: Array<{ path: string; target: string }> = [];
			const maps = new Map<string, Record<string, string>>();
			for (const edge of approved.edges) {
				if (edge.target === null || edge.from === controller) continue;
				const from = frozen.get(edge.from),
					target = frozen.get(edge.target);
				if (!from || !target) throw new Error("Invalid frozen dependency graph");
				const map = maps.get(from) ?? {};
				if (map[edge.name] && map[edge.name] !== target) throw new Error("Conflicting dependency mapping");
				map[edge.name] = target;
				maps.set(from, map);
			}
			for (const [from, map] of maps) {
				for (const [name, target] of Object.entries(map)) {
					active(signal);
					const path = join(from, "node_modules", name);
					await mkdir(dirname(path), { recursive: true, mode: 0o700 });
					await symlink(target, path);
					links.push({ path, target });
				}
			}
			const mappings = Object.fromEntries(
				entryRoots.map((edge) => [edge.name, frozen.get(edge.target ?? "") ?? ""]),
			);
			const portableFingerprint = graphFingerprint(approved, controller, originalImages);
			const graphDigest = sha(JSON.stringify(approved));
			const digest = sha(
				JSON.stringify({
					graphDigest,
					sourceGraphs: sourceGraphs.map(({ context, digest }) => ({ context, digest })),
					portableFingerprint,
					runtimeLock: initialRuntimeLock,
					files: [...original],
				}),
			);
			const observe = async () => {
				active(signal);

				if (JSON.stringify(await runtimeLock(controller, signal)) !== JSON.stringify(initialRuntimeLock))
					throw new Error("Command runtime lock status or identity changed");
				if (sha(JSON.stringify(await inventory(controller, signal))) !== graphDigest)
					throw new Error("Original command dependency resolution changed");
				const custody = await lstat(output);
				if (
					(await realpath(output)) !== output ||
					!custody.isDirectory() ||
					(custody.mode & 0o077) !== 0 ||
					custody.uid !== process.getuid?.()
				)
					throw new Error("Command dependency custody directory changed");
				if (
					JSON.stringify((await readdir(output)).sort()) !==
					JSON.stringify([...frozen.values()].map((path) => relative(output, path)).sort())
				)
					throw new Error("Frozen command dependency inventory changed");
				for (const link of links)
					if (
						(await lstat(link.path)).isSymbolicLink() !== true ||
						(await readlink(link.path)) !== link.target ||
						(await realpath(link.path)) !== link.target
					)
						throw new Error("Frozen command dependency mapping changed");
				// Reuse complete byte images only within this one observation for shared physical nodes.
				const observedImages = new Map<string, PackageImage>();
				for (const [root, target] of frozen) {
					const expected = original.get(root),
						observed = await fileIdentity(root, signal);
					if (observed.digest !== expected || (await fileIdentity(target, signal)).digest !== expected)
						throw new Error("Command dependency bytes or modes changed");
					observedImages.set(root, observed);
				}
				for (const source of sourceGraphs) {
					active(signal);
					const current = await inventory(source.context, signal);
					if (sha(JSON.stringify(current)) !== source.digest)
						throw new Error("Source command dependency resolution changed");
					let entries = 0,
						size = 0;
					for (const root of current.roots) {
						active(signal);
						let image = observedImages.get(root);
						if (!image) {
							image = await fileIdentity(root, signal, undefined, MAX_BYTES - size, 20000 - entries);
							observedImages.set(root, image);
						}
						entries += image.entries;
						size += image.size;
						if (entries > 20000 || size > MAX_BYTES)
							throw new Error("Source command dependency graph exceeded its limits");
					}
					if (graphFingerprint(current, source.context, observedImages) !== portableFingerprint)
						throw new Error(
							"Source command dependency bytes, modes or instance topology differ from the controller",
						);
				}
				// Every nested mapping directory must contain only the issued links.
				for (const target of frozen.values()) {
					active(signal);
					const map = maps.get(target) ?? {};
					const mappingRoot = join(target, "node_modules");
					const mappingStat = await lstat(mappingRoot).catch((error: unknown) => {
						if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
							return null;
						throw error;
					});
					if (Object.keys(map).length === 0) {
						if (mappingStat !== null) throw new Error("Unexpected nested dependency mapping");
						continue;
					}
					if (mappingStat === null || !mappingStat.isDirectory() || (await realpath(mappingRoot)) !== mappingRoot)
						throw new Error("Command dependency mapping directory changed");
					const expected = Object.keys(map).sort();
					const actual: string[] = [];
					const mappingEntries = await readdir(mappingRoot, { withFileTypes: true });
					const expectedTop = [
						...new Set(expected.map((name) => (name.startsWith("@") ? name.split("/")[0] : name))),
					].sort();
					if (JSON.stringify(mappingEntries.map((entry) => entry.name).sort()) !== JSON.stringify(expectedTop))
						throw new Error("Unexpected nested dependency mapping");
					for (const entry of mappingEntries) {
						if (entry.name.startsWith("@") && entry.isDirectory()) {
							if ((await realpath(join(mappingRoot, entry.name))) !== join(mappingRoot, entry.name))
								throw new Error("Dependency scope mapping changed");
							for (const child of await readdir(join(target, "node_modules", entry.name)))
								actual.push(`${entry.name}/${child}`);
						} else actual.push(entry.name);
					}
					if (JSON.stringify(actual.sort()) !== JSON.stringify(expected))
						throw new Error("Unexpected nested dependency mapping");
				}
				active(signal);
				return digest;
			};
			await observe();
			return Object.freeze({
				root: output,
				mappings: Object.freeze(mappings),
				digest,
				runtimeLock: initialRuntimeLock,
				observe,
			});
		})
		.catch(async (cause: unknown) => {
			await rm(output, { recursive: true, force: true });
			throw cause;
		});
}
