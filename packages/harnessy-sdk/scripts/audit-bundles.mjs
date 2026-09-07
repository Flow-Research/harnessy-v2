import { builtinModules } from "node:module";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const dist = new URL("../dist/", import.meta.url);
const requiredFiles = ["index.js", "index.d.ts", "node.js", "node.d.ts"];

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const runtimeDependencies = new Set(Object.keys(manifest.dependencies ?? {}));
for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error(`Harnessy SDK dependency ${dependency} must use an exact version, got ${version}`);
	}
}

const files = (await readdir(dist)).sort();
for (const required of requiredFiles) {
	if (!files.includes(required)) throw new Error(`Harnessy SDK bundle is missing ${required}`);
}
for (const file of files) {
	if (!/\.(?:js|d\.ts)$/.test(file)) {
		throw new Error(`Harnessy SDK dist contains unexpected file ${file}`);
	}
}

const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const importSpecifiers = (file, source) => {
	const sourceFile = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".d.ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
	);
	const specifiers = [];
	const visit = (node) => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			specifiers.push(node.moduleSpecifier.text);
		} else if (
			ts.isCallExpression(node) &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0]) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && ["require", "__require"].includes(node.expression.text)))
		) {
			specifiers.push(node.arguments[0].text);
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteral(node.argument.literal)
		) {
			specifiers.push(node.argument.literal.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return specifiers;
};

const isDeclaredRuntimeImport = (specifier) => {
	if (/^\.{1,2}\//.test(specifier) || specifier.startsWith("node:")) return true;
	for (const dependency of runtimeDependencies) {
		if (specifier === dependency || specifier.startsWith(`${dependency}/`)) return true;
	}
	return false;
};

const specifiersByFile = new Map();
const builtinImportsByFile = new Map();
for (const file of files) {
	const path = new URL(file, dist);
	const source = await readFile(path, "utf8");
	if (file.endsWith(".d.ts") && /(?:StorageError_base|UniqueViolationError_base)/.test(source)) {
		throw new Error(`Harnessy SDK ${file} exposes a vendored Executor error type`);
	}
	if (file.endsWith(".js") || file.endsWith(".d.ts")) {
		const specifiers = importSpecifiers(file, source);
		specifiersByFile.set(file, specifiers);
		for (const specifier of specifiers) {
			if (specifier.startsWith("@executor-js/")) {
				throw new Error(`Harnessy SDK ${file} exposes a vendored Executor package import`);
			}
			if (nodeBuiltins.has(specifier.replace(/^node:/, ""))) {
				builtinImportsByFile.set(file, [...(builtinImportsByFile.get(file) ?? []), specifier]);
				continue;
			}
			if (isDeclaredRuntimeImport(specifier)) continue;
			throw new Error(`Harnessy SDK ${file} retains undeclared runtime import ${specifier}`);
		}
	}
}

const resolveLocalTarget = (importer, specifier) => {
	const literalTarget = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
	if (path.posix.isAbsolute(literalTarget) || literalTarget === ".." || literalTarget.startsWith("../")) {
		throw new Error(`Harnessy SDK ${importer} local import escapes dist: ${specifier}`);
	}
	const declarationTarget =
		importer.endsWith(".d.ts") && literalTarget.endsWith(".js")
			? `${literalTarget.slice(0, -3)}.d.ts`
			: undefined;
	const candidates = [declarationTarget, literalTarget].filter((candidate) => candidate !== undefined);
	const target = candidates.find((candidate) => files.includes(candidate));
	if (target === undefined) {
		throw new Error(
			`Harnessy SDK ${importer} has unresolved local import ${specifier}; checked ${candidates.join(", ")}`,
		);
	}
	return target;
};

const localEdgesByFile = new Map();
for (const [file, specifiers] of specifiersByFile) {
	localEdgesByFile.set(
		file,
		specifiers.filter((specifier) => /^\.{1,2}\//.test(specifier)).map((specifier) => resolveLocalTarget(file, specifier)),
	);
}

const stableReachable = new Set();
const visitStable = (file) => {
	if (stableReachable.has(file)) return;
	stableReachable.add(file);
	for (const target of localEdgesByFile.get(file) ?? []) {
		visitStable(target);
	}
};
visitStable("index.js");
visitStable("index.d.ts");
const composeDeclarations = files.filter((file) => /^compose-[^.]+\.d\.ts$/.test(file));
if (composeDeclarations.length === 0 || composeDeclarations.some((file) => !stableReachable.has(file))) {
	throw new Error(
		`Harnessy SDK stable declaration closure does not include compose declaration: ${composeDeclarations.join(", ")}`,
	);
}
for (const file of stableReachable) {
	const builtins = builtinImportsByFile.get(file) ?? [];
	if (builtins.length > 0) {
		throw new Error(`Harnessy SDK stable root reaches Node-only imports in ${file}: ${builtins.join(", ")}`);
	}
}

const sizes = Object.fromEntries(
	await Promise.all(files.map(async (file) => [file, (await stat(new URL(file, dist))).size])),
);
console.log(
	JSON.stringify(
		{
			files: sizes,
			stableRoot: "portable",
			stableRootFiles: [...stableReachable].sort(),
			executorImports: 0,
			auditMode: "read-only",
		},
		undefined,
		2,
	),
);
