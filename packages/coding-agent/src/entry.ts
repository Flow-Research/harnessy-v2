import process from "node:process";

import { APP_NAME, type AppIdentityConfig, configureAppIdentity } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { type MainOptions, main } from "./main.ts";

export interface PiCliEntrypointOptions extends MainOptions {
	readonly appIdentity?: AppIdentityConfig;
	readonly title?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly suppressWarnings?: boolean;
}

export const runPiCli = (args: ReadonlyArray<string>, options?: PiCliEntrypointOptions): Promise<void> => {
	for (const [key, value] of Object.entries(options?.env ?? {})) {
		process.env[key] = value;
	}
	configureAppIdentity(options?.appIdentity);
	process.title = options?.title ?? APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	if (options?.suppressWarnings ?? true) {
		process.emitWarning = (() => {}) as typeof process.emitWarning;
	}

	// Configure undici's global dispatcher before provider SDKs issue requests.
	// Runtime settings are applied again once SettingsManager has loaded settings.
	configureHttpDispatcher();

	return main([...args], options);
};
