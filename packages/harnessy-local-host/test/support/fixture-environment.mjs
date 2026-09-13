import { fileURLToPath } from "node:url";

const guardPath = fileURLToPath(new URL("./fixture-network-guard.mjs", import.meta.url));

export const fixtureEnvironment = (source = process.env) => {
	const allowed = ["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "PATHEXT"];
	return {
		...Object.fromEntries(allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])),
		NODE_OPTIONS: `--import=${JSON.stringify(guardPath)}`,
		NODE_NO_WARNINGS: "1",
		npm_config_update_notifier: "false",
		npm_config_offline: "true",
	};
};
