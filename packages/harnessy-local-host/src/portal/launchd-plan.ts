/**
 * The planned macOS LaunchAgent for the portal. Phase 1 only prints it; nothing
 * here installs, loads or enables a service.
 */
import { join } from "node:path";

import { PORTAL_SERVICE_LABEL } from "@harnessy/core/read-model";

import { PORTAL_LOG_DIRECTORY } from "./token-store.ts";

export interface PortalLaunchAgentPlan {
	readonly nodePath: string;
	readonly cliPath: string;
	readonly port: number;
	readonly stateDir: string;
}

const xml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");

/**
 * `KeepAlive` is true: the portal is a known non-writer, so a restart cannot
 * repeat a publication (contrast the meeting service, which is deliberately false).
 */
export const renderPortalLaunchAgent = (plan: PortalLaunchAgentPlan): string => {
	const logs = join(plan.stateDir, PORTAL_LOG_DIRECTORY);
	const args = [plan.nodePath, plan.cliPath, "serve", "--port", String(plan.port), "--state-dir", plan.stateDir];
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${PORTAL_SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>
${args.map((value) => `<string>${xml(value)}</string>`).join("\n")}
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(join(logs, "stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, "stderr.log"))}</string>
</dict></plist>
`;
};
