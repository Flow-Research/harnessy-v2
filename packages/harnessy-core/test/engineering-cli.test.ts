import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEngineeringCommand } from "../src/cli/engineering.ts";
import type { EngineeringJob } from "../src/engineering/contracts.ts";
import { EngineeringStore } from "../src/engineering/store.ts";
import { engineeringBenchmarkFixture } from "./fixtures/engineering-benchmark.ts";

const roots: string[] = [];
const pending: Promise<unknown>[] = [];
let lifetime = new AbortController();
beforeEach(() => {
	lifetime = new AbortController();
});
function runObserved<A>(effect: Effect.Effect<A, unknown>) {
	const result = Effect.runPromise(effect, { signal: lifetime.signal });
	pending.push(result);
	return result;
}
afterEach(async () => {
	lifetime.abort();
	await Promise.allSettled(pending.splice(0));
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("engineering owner CLI", () => {
	it("allows only declared profiles and enforces their overall deadline before filesystem preparation", async () => {
		const args = [
			"benchmark",
			"harnessy",
			"--baseline",
			"/unused-baseline",
			"--candidate",
			"/unused-candidate",
			"--output",
			"/unused-output",
			"--timeout-seconds",
			"0",
		];
		const run = (profile: string) =>
			runObserved(
				Command.runWith(
					makeEngineeringCommand(() => "/unused-state.sqlite"),
					{ version: "test" },
				)([...args, "--profile", profile]).pipe(Effect.provide(NodeServices.layer)),
			);
		await expect(run("local-status")).rejects.toThrow(
			process.platform === "darwin" ? /deadline/ : /unsupported|require/i,
		);
		await expect(run("startup")).rejects.toThrow();
		await expect(run("arbitrary-shell")).rejects.toThrow();
	});

	it.skipIf(process.platform !== "darwin")(
		"runs the actual protected benchmark command and rejects JSON policy or unsupported collectors",
		async () => {
			const fixture = await engineeringBenchmarkFixture();
			roots.push(fixture.root);
			const run = (args: string[]) =>
				runObserved(
					Command.runWith(
						makeEngineeringCommand(() => join(fixture.root, "unused.sqlite")),
						{ version: "test" },
					)(args).pipe(Effect.provide(NodeServices.layer)),
				);
			const printed = vi.spyOn(console, "log").mockImplementation(() => {});
			await run([
				"benchmark",
				"harnessy",
				"--baseline",
				fixture.baseline,
				"--candidate",
				fixture.baseline,
				"--output",
				fixture.output,
			]);
			const result = JSON.parse(String(printed.mock.calls.at(-1)?.[0]));
			expect(result.measurementStatus).toBe("observed");
			expect(result.decision.verdict).toBe("inconclusive");
			expect(result.reportPath).toBe(join(fixture.output, "reports/benchmark.json"));
			await expect(run(["benchmark", "harnessy", "--policy", "forged.json"])).rejects.toThrow();
			await expect(run(["benchmark", "garden"])).rejects.toThrow();
		},
		305000,
	);
	it("approves one exact job, exposes its receipt, and revokes it without claiming termination", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-cli-")));
		roots.push(root);
		const database = join(root, "state.sqlite");
		const input = join(root, "job.json");
		const job: EngineeringJob = {
			schema: "harnessy.engineering.job.v1",
			id: randomUUID(),
			objective: "native-controls",
			taskId: randomUUID(),
			taskRevision: "f".repeat(64),
			workspace: "julian",
			repository: "garden",
			lane: "native",
			sourceRevision: "a".repeat(40),
			evaluatorDigest: "b".repeat(64),
			workloadDigest: "c".repeat(64),
		};
		writeFileSync(input, JSON.stringify(job));
		const run = (args: string[]) =>
			runObserved(
				Command.runWith(
					makeEngineeringCommand(
						() => database,
						() => 1000,
					),
					{ version: "test" },
				)(args).pipe(Effect.provide(NodeServices.layer)),
			);
		const printed = vi.spyOn(console, "log").mockImplementation(() => {});
		await run(["approve", "--job", input, "--expires-minutes", "30"]);
		const receipt = JSON.parse(String(printed.mock.calls.at(-1)?.[0]));
		expect(receipt.jobId).toBe(job.id);
		expect(receipt.grant.expiresAt).toBe(1_801_000);
		await run(["status"]);
		const status = JSON.parse(String(printed.mock.calls.at(-1)?.[0]));
		expect(status.approvedJobs).toHaveLength(1);
		expect(status.activeRun).toBeNull();
		const store = new EngineeringStore(database);
		try {
			store.reserve(job.id, receipt.grant.id, "owned", 1000);
		} finally {
			store.close();
		}
		await run(["cancel", "--run", "owned"]);
		expect(JSON.parse(String(printed.mock.calls.at(-1)?.[0])).state).toBe("cancel_requested");
		await run(["events", "--after", "1"]);
		expect(JSON.parse(String(printed.mock.calls.at(-1)?.[0])).events).toHaveLength(1);
		await run(["revoke", "--grant", receipt.grant.id]);
		expect(JSON.parse(String(printed.mock.calls.at(-1)?.[0])).termination).toBe("not-confirmed");
		await expect(run(["approve", "--job", input, "--expires-minutes", "0"])).rejects.toThrow(/lifetime/);
		writeFileSync(input, JSON.stringify({ ...job, argv: ["arbitrary-shell"] }));
		await expect(run(["approve", "--job", input])).rejects.toThrow();
	});
});
