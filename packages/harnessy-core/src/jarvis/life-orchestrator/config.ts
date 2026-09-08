import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import * as Result from "effect/Result";

import type { LifeFeedSource } from "./research.ts";

export interface LifeOrchestratorPaths {
	readonly projectRoot: string;
	readonly homeRoot: string;
	readonly lifeDirectory: string;
	readonly stateDirectory: string;
	readonly databasePath: string;
	readonly reviewDirectory: string;
	readonly researchStatusDirectory: string;
	readonly rawArticlesDirectory: string;
	readonly steeringPath: string;
	readonly compatibilityScriptsDirectory: string;
}

export interface LifeOrchestratorSettings {
	readonly paths: LifeOrchestratorPaths;
	readonly lookbackDays: number;
	readonly targetReadings: number;
	readonly maximumReadings: number;
	readonly sources: ReadonlyArray<LifeFeedSource>;
}

export interface ResolveLifeSettingsOptions {
	readonly projectRoot?: string;
	readonly homeRoot?: string;
	readonly compatibilityRoot?: string;
	readonly user?: string;
}

const record = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const stringValue = (value: unknown, fallback: string): string =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;

const intValue = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
};

const boolValue = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

const stringArray = (value: unknown): ReadonlyArray<string> =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];

const readJsonRecord = (path: string): Record<string, unknown> => {
	if (!existsSync(path)) return {};
	const parsed = Result.try(() => JSON.parse(readFileSync(path, "utf8")) as unknown);
	return Result.isSuccess(parsed) ? (record(parsed.success) ?? {}) : {};
};

const feedSources = (reading: Record<string, unknown>): ReadonlyArray<LifeFeedSource> => {
	const values = reading.sources;
	if (!Array.isArray(values)) return [];
	const sources: Array<LifeFeedSource> = [];
	for (const rawValue of values) {
		const value = record(rawValue);
		if (value === null) continue;
		const url = stringValue(value.url, "");
		if (!/^https?:\/\//i.test(url)) continue;
		sources.push({
			name: stringValue(value.name, new URL(url).hostname),
			url,
			topic: stringValue(value.topic, "Configured reading source"),
			enabled: boolValue(value.enabled, true),
			format: value.content_mode === "hn_search" ? "hn-search" : "rss",
			maxItemsPerPoll: intValue(value.max_items_per_poll, 5, 1, 20),
			maxPerBrief: intValue(value.max_per_brief, 3, 1, 3),
			evergreenEnabled: boolValue(value.evergreen_enabled, false),
			maxEvergreenPerPoll: intValue(value.max_evergreen_per_poll, 1, 0, 5),
			evergreenKeywords: stringArray(value.evergreen_keywords),
			includeKeywords: stringArray(value.include_keywords),
			includeScope: value.include_scope === "title" ? "title" : "title-description",
			excludeTitlePatterns: stringArray(value.exclude_title_patterns),
		});
	}
	return sources;
};

/** Resolve V2-owned state alongside explicit, pinned V1 compatibility adapters. */
export const resolveLifeOrchestratorSettings = (options: ResolveLifeSettingsOptions = {}): LifeOrchestratorSettings => {
	const projectRoot = resolve(options.projectRoot ?? process.cwd());
	const homeRoot = resolve(options.homeRoot ?? homedir());
	const user = options.user ?? process.env.FLOW_USER ?? process.env.USER ?? "default";
	const lifeDirectory = join(homeRoot, ".agents", "life");
	const stateDirectory = join(homeRoot, ".harnessy", "jarvis", "life");
	const config = readJsonRecord(join(lifeDirectory, "config.json"));
	const reading = record(config.reading) ?? {};
	const compatibilityScriptsDirectory = resolve(
		options.compatibilityRoot ??
			process.env.HARNESSY_LIFE_V1_SCRIPTS ??
			join(
				projectRoot,
				"packages",
				"capability-harnessy-v1-full",
				"resources",
				"flow-install",
				"skills",
				"life-orchestrator",
				"scripts",
			),
	);
	return {
		paths: {
			projectRoot,
			homeRoot,
			lifeDirectory,
			stateDirectory,
			databasePath: join(stateDirectory, "life-orchestrator.sqlite3"),
			reviewDirectory: join(stateDirectory, "reviews"),
			researchStatusDirectory: join(stateDirectory, "research"),
			rawArticlesDirectory: join(homeRoot, ".jarvis", "wikis", "founder-learning", "raw", "articles"),
			steeringPath: join(projectRoot, ".jarvis", "context", "private", user, "learning-research.md"),
			compatibilityScriptsDirectory,
		},
		lookbackDays: intValue(reading.lookback_days, 21, 1, 3_650),
		targetReadings: intValue(reading.minimum, 2, 0, 3),
		maximumReadings: 3,
		sources: feedSources(reading),
	};
};
