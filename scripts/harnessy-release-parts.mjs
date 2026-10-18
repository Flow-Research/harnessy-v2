// CI runs the installed-consumer parts of the packed release smoke in parallel jobs;
// together they run every check. With no --part argument the smoke runs both parts.
export const harnessyReleaseParts = Object.freeze(["installed-local-host", "installed-product"]);

/** Returns the parts the given command-line arguments select, in run order. */
export const selectedHarnessyReleaseParts = (args) => {
	if (args.length === 0) return [...harnessyReleaseParts];
	const requested = /^--part=(.+)$/u.exec(args[0] ?? "")?.[1];
	if (args.length > 1 || requested === undefined || !harnessyReleaseParts.includes(requested)) {
		throw new Error(`Usage: test-harnessy-release.mjs [--part=${harnessyReleaseParts.join("|")}]`);
	}
	return [requested];
};
