import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { afterEach, describe, expect, it } from "vitest";
import {
	FATHOM_LAUNCH_AGENT_LABEL,
	FATHOM_POLL_INTERVAL_SECONDS,
	installFathomSchedule,
	planFathomSchedule,
} from "../src/jarvis/fathom/schedule.ts";
import { JarvisPathResolver, JarvisRuntimeRoots } from "../src/jarvis/paths.ts";

const roots: string[] = [];
const root = () => {
	const value = mkdtempSync(join(tmpdir(), "harnessy-fathom-schedule-"));
	roots.push(value);
	return value;
};

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

const resolvePaths = (home: string, target: string) =>
	Effect.runPromise(
		JarvisPathResolver.pipe(
			Effect.flatMap((resolver) => resolver.resolve(target)),
			Effect.provide(JarvisPathResolver.layer),
			Effect.provide(JarvisRuntimeRoots.testLayer(home)),
			Effect.provide(Path.layer),
		),
	);

describe("V2 Fathom schedule", () => {
	it("plans a single bounded five-minute V2 poll job", async () => {
		const home = root();
		const target = join(home, "project");
		const node = join(home, "node");
		const cli = join(home, "cli.js");
		const launch = join(home, "LaunchAgents");
		mkdirSync(target, { recursive: true });
		mkdirSync(launch, { recursive: true });
		writeFileSync(node, "node");
		writeFileSync(cli, "cli");
		const paths = await resolvePaths(home, target);
		const planned = await Effect.runPromise(
			planFathomSchedule(paths, { nodePath: node, cliPath: cli, launchAgentsDirectory: launch }),
		);
		expect(planned.label).toBe(FATHOM_LAUNCH_AGENT_LABEL);
		expect(planned.content).toContain(`<integer>${FATHOM_POLL_INTERVAL_SECONDS}</integer>`);
		expect(planned.content).toContain("<string>fathom</string>");
		expect(planned.content).toContain("<string>poll</string>");
		expect(planned.content).not.toContain("--account");
	});

	it("backs up only the Fathom plist and leaves unrelated jobs untouched", async () => {
		const home = root();
		const target = join(home, "project");
		const node = join(home, "node");
		const cli = join(home, "cli.js");
		const launch = join(home, "LaunchAgents");
		mkdirSync(target, { recursive: true });
		mkdirSync(launch, { recursive: true });
		writeFileSync(node, "node");
		writeFileSync(cli, "cli");
		writeFileSync(join(launch, `${FATHOM_LAUNCH_AGENT_LABEL}.plist`), "old");
		writeFileSync(join(launch, "com.example.unrelated.plist"), "keep");
		const paths = await resolvePaths(home, target);
		const result = await Effect.runPromise(
			installFathomSchedule(paths, {
				nodePath: node,
				cliPath: cli,
				launchAgentsDirectory: launch,
				now: new Date("2026-09-18T10:00:00.000Z"),
			}),
		);
		expect(result.applied).toBe(true);
		expect(readFileSync(join(launch, "com.example.unrelated.plist"), "utf8")).toBe("keep");
		expect(readFileSync(join(result.backupDirectory ?? "", `${FATHOM_LAUNCH_AGENT_LABEL}.plist`), "utf8")).toBe(
			"old",
		);
	});
});
