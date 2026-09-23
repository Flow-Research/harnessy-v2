import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// Only actual output contributions count. This does not use generated comments
// or infer permission text from SPDX identifiers.
export function bundleNotices(metafile, packageRoot) {
	const repo = realpathSync(resolve(packageRoot, "../.."));
	const sources = new Set(Object.values(metafile.outputs).flatMap((output) =>
		Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([file]) => file)));
	if (sources.size === 0) throw new Error("SDK bundle has no attributed inputs");
	const components = new Map();
	for (const source of sources) {
		const absolute = realpathSync(resolve(packageRoot, source));
		const logical = relative(repo, absolute).split(sep).join("/");
		if (logical.startsWith("../") || logical === "..") throw new Error("SDK bundle input escapes repository");
		if (logical.startsWith("packages/harnessy-sdk/src/")) continue;
		if (!logical.includes("node_modules/")) {
			if (!logical.startsWith("executor/")) throw new Error(`Unclassified SDK bundle input: ${logical}`);
			components.set("Executor (vendored)", [["LICENSE", readFileSync(join(repo, "executor/LICENSE"), "utf8")]]);
			// Preserve notices belonging to nested vendor copies as well as Executor.
			for (let directory = dirname(absolute); directory !== join(repo, "executor"); directory = dirname(directory)) {
				const notices = readdirSync(directory).filter((name) => /^(?:licen[cs]e|notice|copying)(?:\.|$)/iu.test(name)).sort();
				if (notices.length) components.set(relative(repo, directory).split(sep).join("/"),
					notices.map((name) => [name, readFileSync(join(directory, name), "utf8")]));
			}
			continue;
		}
		const parts = absolute.split(sep);
		const start = parts.lastIndexOf("node_modules") + 1;
		const root = parts.slice(0, start + (parts[start].startsWith("@") ? 2 : 1)).join(sep);
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		if (!manifest.name || !manifest.version) throw new Error("Bundled dependency has no name/version");
		const id = `${manifest.name}@${manifest.version}`;
		const names = readdirSync(root).filter((name) => /^(?:licen[cs]e|notice|copying)(?:\.|$)/iu.test(name)).sort();
		let notices = names.map((name) => [name, readFileSync(join(root, name), "utf8")]);
		if (notices.length === 0 && id === "@cfworker/json-schema@4.1.1") {
			notices = [["Pinned upstream notice", readFileSync(join(packageRoot, "THIRD_PARTY_LICENSES/cfworker-json-schema.txt"), "utf8")]];
		}
		if (notices.length === 0 || notices.some(([, text]) => text.trim().length === 0))
			throw new Error(`Bundled dependency lacks notice text: ${id}`);
		if (components.has(id) && JSON.stringify(components.get(id)) !== JSON.stringify(notices))
			throw new Error(`Conflicting bundled notices: ${id}`);
		components.set(id, notices);
	}
	return "# Bundled third-party notices\n\nThese notices apply to bundled components; the package license remains separate.\n\n" +
		[...components].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
			.map(([id, notices]) => `## ${id}\n\n${notices.map(([name, text]) => `### ${name}\n\n${text.trimEnd()}\n`).join("\n")}`)
			.join("\n");
}
