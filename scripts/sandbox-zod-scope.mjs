// Julian approved this root development copy only. The standalone sandbox
// example has its own lock and does not use the root audit exception.
export const sandboxZodAdvisory = "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5";
const parent = "@anthropic-ai/sandbox-runtime";
const parentPath = `node_modules/${parent}`;
export const sandboxZodPath = `${parentPath}/node_modules/zod`;

export const isReviewedSandboxZod = (packages) => {
	const root = packages?.[""];
	const owner = packages?.[parentPath];
	const zod = packages?.[sandboxZodPath];
	return root?.devDependencies?.[parent] === "0.0.26" &&
		!Object.hasOwn(root?.dependencies ?? {}, parent) &&
		!Object.hasOwn(root?.optionalDependencies ?? {}, parent) &&
		owner?.version === "0.0.26" && owner.dev === true && owner.dependencies?.zod === "^3.24.1" &&
		zod?.version === "3.25.76" && zod.dev === true;
};
