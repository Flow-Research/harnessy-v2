import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type PortalServer, startPortalServer } from "../src/portal/server.ts";
import { createPortalSources } from "../src/portal/sources.ts";
import { newPortalSecret } from "../src/portal/token-store.ts";
import { createWeeklyDraftCloser, createWeeklyRunInspector } from "../src/portal/weekly-close.ts";
import { buildPortalHome, cleanupPortalFixtures, FIXTURE_NOW } from "./support/portal-fixture.ts";
import { installProof, rawRequest } from "./support/portal-http.ts";

let server: PortalServer | undefined;
afterEach(async () => {
	await server?.close();
	cleanupPortalFixtures();
});

it("shows recorded failures and closes them as abandoned without changing their evidence", async () => {
	const fixture = await buildPortalHome("weekly-failed");
	const hash = createHash("sha256").update("2026-W42").digest("hex");
	const directory = join(fixture.home, ".harnessy/jarvis/life/reviews", `weekly-2026-W42-${hash}`);
	rmSync(join(directory, "draft.md"));
	const failure = {
		status: "failed",
		phase: "generation",
		errors: ["Login could not be renewed."],
		recordedAt: "2026-10-25T17:49:52Z",
		rawDraftPreserved: false,
	};
	writeFileSync(join(directory, "outcome.json"), JSON.stringify(failure));
	const inspect = createWeeklyRunInspector({ homeRoot: fixture.home });
	expect(inspect(hash)).toMatchObject({
		state: "failed",
		failure: { phase: "generation", errors: failure.errors },
		evidenceUnavailable: false,
	});
	createWeeklyDraftCloser({ homeRoot: fixture.home })(hash, "Past week; no longer required.");
	expect(JSON.parse(readFileSync(join(directory, "reconciliation.json"), "utf8"))).toMatchObject({
		decision: "abandoned",
		priorState: "failed",
	});
	expect(JSON.parse(readFileSync(join(directory, "outcome.json"), "utf8"))).toEqual(failure);
	expect(inspect(hash).state).toBe("reconciled");
	writeFileSync(join(directory, "outcome.json"), "invalid JSON");
	expect(inspect(hash).failure).toBeNull();
	expect(() => inspect("f".repeat(64))).toThrow("weekly_run_missing");
});

it("requires browser authentication, origin and a reason; closes only the selected draft and keeps evidence", async () => {
	const fixture = await buildPortalHome("weekly-close");
	const hash = createHash("sha256").update("2026-W42").digest("hex");
	const directory = join(fixture.home, ".harnessy/jarvis/life/reviews", `weekly-2026-W42-${hash}`);
	const before = readFileSync(join(directory, "draft.md"));
	const token = newPortalSecret();
	const sources = createPortalSources({
		homeRoot: fixture.home,
		env: {},
		probe: () => "unsupported",
		probePort: async () => false,
		timeoutMs: 250,
		clock: () => FIXTURE_NOW,
	});
	let signalRead = () => {};
	const readStarted = new Promise<void>((resolve) => {
		signalRead = resolve;
	});
	let releaseRead = () => {};
	const readReleased = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	let signalClose = () => {};
	const closeStarted = new Promise<void>((resolve) => {
		signalClose = resolve;
	});
	let holdRead = true;
	server = await startPortalServer({
		installToken: token,
		port: 0,
		version: "test",
		sources: {
			...sources,
			inbox: async (params) => {
				const snapshot = await sources.inbox(params);
				if (holdRead) {
					holdRead = false;
					signalRead();
					await readReleased;
				}
				return snapshot;
			},
		},
		closeWeeklyDraft: (run, reason) => {
			createWeeklyDraftCloser({ homeRoot: fixture.home })(run, reason);
			signalClose();
		},
	});
	const path = `/v1/life/weekly/${hash}/close`;
	const post = (body: string, headers: Record<string, string> = {}) =>
		rawRequest(server!.port, {
			method: "POST",
			path,
			body,
			headers: { "Content-Type": "application/json", ...headers },
		});
	expect((await post('{"reason":"done"}')).status).toBe(401);
	expect((await post('{"reason":"done"}', await installProof(server.port, token, "POST", path))).status).toBe(401);
	const issued = await rawRequest(server.port, {
		method: "POST",
		path: "/v1/session/code",
		headers: await installProof(server.port, token, "POST", "/v1/session/code"),
	});
	const grant = await rawRequest(server.port, {
		method: "POST",
		path: "/v1/session/exchange",
		headers: { Origin: server.origin, "Content-Type": "application/json" },
		body: JSON.stringify({ code: (issued.json as { code: string }).code }),
	});
	const auth = { Authorization: `Bearer ${(grant.json as { token: string }).token}` };
	expect((await post('{"reason":"done"}', auth)).status).toBe(403);
	const headers = { ...auth, Origin: server.origin };
	for (const body of [
		"{}",
		'{"reason":" "}',
		'{"reason":"done","force":true}',
		"null",
		"broken",
		JSON.stringify({ reason: "a".repeat(201) }),
	])
		expect((await post(body, headers)).status).toBe(400);
	expect((await post('{"reason":"done"}', { ...headers, Origin: "https://example.test" })).status).toBe(403);
	expect(existsSync(join(directory, "reconciliation.json"))).toBe(false);
	// A stale view must not close a failed or active run.
	rmSync(join(directory, "draft.md"));
	expect((await post('{"reason":"done"}', headers)).status).toBe(409);
	writeFileSync(join(directory, "draft.md"), before);
	const inboxBefore = rawRequest(server.port, { path: "/v1/inbox", headers: auth });
	await readStarted;
	const closing = post('{"reason":"The week has passed."}', headers);
	await closeStarted;
	// Return a pre-close source snapshot after the write, as a slow polling read can do.
	releaseRead();
	expect((await inboxBefore).text).toContain("Review weekly plan");
	expect((await closing).status).toBe(200);
	const record = readFileSync(join(directory, "reconciliation.json"), "utf8");
	expect(JSON.parse(record)).toMatchObject({
		decision: "superseded",
		reason: "The week has passed.",
		priorState: "drafted",
	});
	expect(readFileSync(join(directory, "draft.md"))).toEqual(before);
	expect((await rawRequest(server.port, { path: "/v1/inbox", headers: auth })).text).not.toContain(
		"Review weekly plan",
	);
	// A retry after a lost response does not replace the recorded decision.
	expect((await post('{"reason":"Retry"}', headers)).status).toBe(200);
	expect(readFileSync(join(directory, "reconciliation.json"), "utf8")).toBe(record);
});
