import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Create a new app bundle. Never replace an existing app or register/open it. */
export function installPortalLauncher({ target, portal, stateDir, port = 8790 }) {
	if (process.platform !== "darwin") throw new Error("The native portal launcher requires macOS");
	if (![target, portal, stateDir].every((value) => typeof value === "string" && isAbsolute(value)))
		throw new Error("target, portal and state-dir must be absolute paths");
	if (!target.endsWith(".app") || existsSync(target)) throw new Error("Choose a new .app target");
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid portal port");
	const executable = realpathSync(portal);
	const parent = realpathSync(dirname(target));
	const destination = join(parent, target.slice(target.lastIndexOf("/") + 1));
	mkdirSync(destination, { mode: 0o700 });
	try {
		const compiled = join(destination, "compiled.app");
		execFileSync("/usr/bin/osacompile", ["-o", compiled, fileURLToPath(new URL("portal-launcher.applescript", import.meta.url))], { stdio: "pipe" });
		renameSync(join(compiled, "Contents"), join(destination, "Contents"));
		rmSync(compiled, { recursive: true });
		const resources = join(destination, "Contents/Resources");
		const common = `--port ${port} --state-dir ${quote(stateDir)}`;
		writeFileSync(join(resources, "open-portal"), `#!/bin/sh\nexec ${quote(executable)} open ${common}\n`, { mode: 0o700, flag: "wx" });
		writeFileSync(join(resources, "signin-portal"), `#!/bin/sh\n[ "$#" -eq 1 ] || exit 64\nexec ${quote(executable)} signin --request "$1" ${common}\n`, { mode: 0o700, flag: "wx" });
		const plist = join(destination, "Contents/Info.plist");
		for (const command of [
			"Add :CFBundleIdentifier string dev.harnessy.portal",
			"Add :CFBundleURLTypes array",
			"Add :CFBundleURLTypes:0 dict",
			"Add :CFBundleURLTypes:0:CFBundleURLName string Harnessy portal",
			"Add :CFBundleURLTypes:0:CFBundleURLSchemes array",
			"Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string harnessy",
		]) execFileSync("/usr/libexec/PlistBuddy", ["-c", command, plist], { stdio: "pipe" });
		return destination;
	} catch (error) {
		rmSync(destination, { recursive: true, force: true });
		throw error;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { target: { type: "string" }, portal: { type: "string" }, "state-dir": { type: "string" }, port: { type: "string" } } });
	console.log(installPortalLauncher({ target: values.target, portal: values.portal, stateDir: values["state-dir"], port: Number(values.port ?? 8790) }));
}
