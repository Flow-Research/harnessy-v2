/**
 * Read-only resolution of the meeting publication configuration.
 *
 * `JarvisConfigReader.loadResolved` needs an Effect file system layer. The
 * portal only needs the `meeting_publication` section, read synchronously and
 * bounded, with the same schema decoding, environment overrides and defaults.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { parseDocument } from "yaml";

import { JarvisLegacyConfigInput } from "../jarvis/config.ts";
import {
	type JarvisLegacyConfig,
	type JarvisMeetingPublicationConfig,
	mergeJarvisLegacyConfig,
	resolveJarvisConfig,
} from "../jarvis/config-model.ts";
import { decodeJarvisEnvironment } from "../jarvis/environment.ts";
import { assertDelegatedFileBounded } from "./files.ts";
import { guardTile, okTile, type ReadModelOptions, readClock, stateTile, type TileResult } from "./tile.ts";

export interface MeetingConfigReadOptions extends ReadModelOptions {
	readonly homeRoot?: string;
	/** Defaults to `<homeRoot>/.jarvis/config.yaml`. */
	readonly configPath?: string;
	/** `JARVIS_*` overrides, as the Jarvis configuration reader applies them. Defaults to none. */
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * The resolved meeting publication configuration. An absent configuration file is `missing`;
 * invalid YAML, a schema failure or an invalid `JARVIS_*` override is `error` with a fixed code.
 */
export const readMeetingPublicationConfig = (
	options: MeetingConfigReadOptions = {},
): TileResult<JarvisMeetingPublicationConfig> => {
	const now = readClock(options);
	return guardTile(now, () => {
		const configPath = resolve(
			options.configPath ?? join(resolve(options.homeRoot ?? homedir()), ".jarvis", "config.yaml"),
		);
		if (!existsSync(configPath)) return stateTile("missing", "config_missing", now);
		// A FIFO or an oversize file is `unsafe`; any other read failure becomes `error`.
		assertDelegatedFileBounded(configPath);
		const document = parseDocument(readFileSync(configPath, "utf8"));
		if (document.errors.length > 0) return stateTile("error", "config_invalid", now);
		const decoded = Result.try(
			(): JarvisLegacyConfig => Schema.decodeUnknownSync(JarvisLegacyConfigInput)(document.toJS()),
		);
		if (Result.isFailure(decoded)) return stateTile("error", "config_invalid", now);
		const entries = Object.entries(options.env ?? {}).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		);
		const resolved = Result.try(() =>
			Effect.runSync(
				Effect.gen(function* () {
					const overrides = yield* decodeJarvisEnvironment(entries);
					return yield* resolveJarvisConfig(yield* mergeJarvisLegacyConfig(decoded.success, overrides));
				}),
			),
		);
		if (Result.isFailure(resolved)) return stateTile("error", "environment_invalid", now);
		return okTile(resolved.success.meetingPublication, now);
	});
};
