const PLATFORM_TAG = /^(?:darwin|windows|linux)-(?:x64|arm64)(?:-musl)?$/;
const WORKERD_SUPPORTED_TAGS = new Set([
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"windows-x64",
]);

export const harnessyExecutorAlias = (tag) => {
	if (!PLATFORM_TAG.test(tag)) throw new Error(`Invalid Harnessy Executor platform tag: ${tag}`);
	return `@harnessy/executor-${tag}`;
};

export const harnessyExecutorRuntimeContract = (tag) => {
	harnessyExecutorAlias(tag);
	const workerdSupported = WORKERD_SUPPORTED_TAGS.has(tag);
	return {
		requiredFiles: [
			tag.startsWith("windows-") ? "bin/executor.exe" : "bin/executor",
			"bin/emscripten-module.wasm",
			"bin/onepassword-core_bg.wasm",
			"bin/libsql.node",
			"bin/worker-bundler/dist/index.js",
			"bin/worker-bundler/dist/esbuild.wasm",
			"bin/worker-bundler/dist/index.bundled.js",
			...(workerdSupported ? [tag.startsWith("windows-") ? "bin/workerd.exe" : "bin/workerd"] : []),
		],
		runtimeLimitations: workerdSupported
			? []
			: ["workerd-backed custom app execution is unavailable on this platform and fails explicitly at invocation"],
		releaseBlockers:
			tag === "windows-arm64"
				? [
						"Windows arm64 publication is blocked until a compatible libSQL native sidecar or a proven alternative is available and a real packed Windows arm64 wrapper passes --version and local SQLite/health smoke testing",
					]
				: [],
	};
};

export const assertHarnessyExecutorRuntimeFiles = ({ tag, files }) => {
	const contract = harnessyExecutorRuntimeContract(tag);
	const available = new Set(files);
	const missing = contract.requiredFiles.filter((path) => !available.has(path));
	if (missing.length > 0) {
		throw new Error(`Harnessy Executor ${tag} is missing required runtime files: ${missing.join(", ")}`);
	}
	if (contract.releaseBlockers.length > 0) {
		throw new Error(`Harnessy Executor ${tag} release blocker: ${contract.releaseBlockers.join("; ")}`);
	}
	return contract;
};

export const harnessyExecutorVariantManifest = ({ upstream, version, tag }) => {
	if (upstream.version !== `${version}-${tag}`) {
		throw new Error(`Executor variant ${tag} has version ${String(upstream.version)}, expected ${version}-${tag}`);
	}
	return {
		...upstream,
		name: "@harnessy/executor",
		license: "MIT",
	};
};

export const harnessyExecutorWrapperManifest = ({ source, tags }) => ({
	...source,
	optionalDependencies: Object.fromEntries(
		[...tags]
			.sort()
			.map((tag) => [harnessyExecutorAlias(tag), `npm:@harnessy/executor@${source.version}-${tag}`]),
	),
});
