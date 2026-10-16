import { type DbProvider, type ExecutorDbHandle, Unauthorized } from "@executor-js/api/server";
import { coreTables } from "@executor-js/sdk";
import { createSqliteTestFumaDb } from "@executor-js/sdk/testing";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { type HarnessyEngineR2Bucket, makeHarnessyEngineWorker } from "../src/cloudflare-worker";
import { fauxHarnessyEngineCodeExecutor } from "./helpers/faux-code-executor";

const principal = {
	accountId: "account-1",
	organizationId: "organization-1",
	organizationName: "Harnessy",
	email: "worker@example.com",
	name: "Harnessy Worker",
	avatarUrl: null,
	roles: ["admin"],
} as const;

const context = {
	waitUntil() {},
	passThroughOnException() {},
	props: {},
} satisfies ExecutionContext;

describe("makeHarnessyEngineWorker", () => {
	const disposers: Array<() => Promise<void>> = [];

	afterEach(async () => {
		await Promise.all(disposers.splice(0).map((dispose) => dispose()));
	});

	it("serves an authenticated SQLite-backed request under the configured prefix", async () => {
		let opened = 0;
		let closed = 0;
		const worker = makeHarnessyEngineWorker({
			auth: {
				kind: "provider",
				provider: () => ({
					authenticate: (request) =>
						request.headers.get("authorization") === "Bearer harnessy-test"
							? Effect.succeed(principal)
							: Effect.fail(new Unauthorized({})),
				}),
			},
			postgres: {
				kind: "acquire",
				acquire: () =>
					Effect.promise(async () => {
						opened += 1;
						const sqlite = await createSqliteTestFumaDb({ tables: coreTables });
						return {
							db: sqlite.db,
							fuma: sqlite.fuma,
							close: async () => {
								closed += 1;
								await sqlite.close();
							},
						} as unknown as ExecutorDbHandle;
					}),
			},
			plugins: { api: [] as const },
			codeExecutor: fauxHarnessyEngineCodeExecutor,
			mountPrefix: "/harnessy",
		});
		disposers.push(worker.dispose);

		const unauthorized = await worker.fetch(new Request("https://example.test/harnessy/policies"), {}, context);
		expect(unauthorized.status).toBe(401);
		expect(await unauthorized.text()).toBe("Unauthorized");
		expect(opened).toBe(1);
		expect(closed).toBe(1);

		const authenticated = await worker.fetch(
			new Request("https://example.test/harnessy/policies", {
				headers: { authorization: "Bearer harnessy-test" },
			}),
			{},
			context,
		);
		expect(authenticated.status).toBe(200);
		expect(await authenticated.json()).toEqual([]);
		expect(opened).toBe(2);
		expect(closed).toBe(2);
	});

	it("passes through concrete MCP export identity and rejects automatic R2 with an injected DB layer", () => {
		class HarnessyEngineSessionExport {}
		const worker = makeHarnessyEngineWorker({
			auth: { kind: "provider", provider: () => ({ authenticate: () => Effect.succeed(principal) }) },
			postgres: {
				kind: "acquire",
				acquire: () => Effect.die("not used"),
			},
			plugins: { api: [] as const },
			codeExecutor: fauxHarnessyEngineCodeExecutor,
			mcpExport: HarnessyEngineSessionExport,
		});
		disposers.push(worker.dispose);
		expect(worker.mcpExport).toBe(HarnessyEngineSessionExport);

		expect(() =>
			makeHarnessyEngineWorker({
				auth: { kind: "provider", provider: () => ({ authenticate: () => Effect.succeed(principal) }) },
				postgres: {
					kind: "layer",
					layer: () => Layer.empty as Layer.Layer<DbProvider>,
				},
				r2: { bucket: () => ({}) as unknown as HarnessyEngineR2Bucket },
				plugins: { api: [] as const },
				codeExecutor: fauxHarnessyEngineCodeExecutor,
			}),
		).toThrow(/Harnessy engine cannot attach R2/);
	});
});
