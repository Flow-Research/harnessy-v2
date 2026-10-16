import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLifeOrchestratorSettings } from "../src/jarvis/life-orchestrator/config.ts";
import { lifeDraftGrantPayload } from "../src/jarvis/life-orchestrator/draft-grant-host.ts";
import { canonicalLifeBriefPath } from "../src/jarvis/life-orchestrator/history.ts";
import { prepareLifeDailyPrompt, runLifeDaily } from "../src/jarvis/life-orchestrator/service.ts";
import { LifeReadingLedger } from "../src/jarvis/life-orchestrator/store.ts";
import { CommandRunner, CommandRunResult } from "../src/runtime/command-runner.ts";

const roots: string[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const makeRoot = () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "life-native-test-")));
	roots.push(root);
	return root;
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const noCommands = {
	run: (command: Parameters<typeof CommandRunner.Service.run>[0]) =>
		Effect.sync(() => {
			expect(command.executable).toBe("jarvis");
			expect(command.args.slice(0, 2)).toEqual(["text-hygiene", "clean"]);
			expect(command.args[3]).toBe("--report");
			return new CommandRunResult({
				...command,
				args: [...command.args],
				command: "synthetic hygiene",
				status: "succeeded",
				stdout: "",
				stderr: "",
				exitCode: 0,
			});
		}),
};

function inputs() {
	const root = makeRoot();
	const settings = resolveLifeOrchestratorSettings({
		projectRoot: root,
		homeRoot: root,
		compatibilityRoot: join(root, "absent"),
	});
	const date = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Africa/Lagos",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());
	const request = {
		runId: `daily:${date}:synthetic`,
		kind: "daily",
		provider: "codex",
		model: "synthetic-model",
		prompt: "Synthetic context only",
	} as const;
	const authority = {
		grantId: "synthetic-grant",
		operation: "life.draft",
		runId: request.runId,
		kind: request.kind,
		provider: request.provider,
		model: request.model,
		promptHash: hash(request.prompt),
		expiresAt: new Date(Date.now() + 600000).toISOString(),
		maximumOutputBytes: 2048,
	} as const;
	const keys = generateKeyPairSync("ed25519");
	const grant = {
		issuer: "synthetic-owner",
		authority,
		signature: sign(null, Buffer.from(lifeDraftGrantPayload("synthetic-owner", authority)), keys.privateKey).toString(
			"base64",
		),
	};
	const nativePreview = {
		requestPath: join(root, "request.json"),
		grantPath: join(root, "grant.json"),
		trustedPublicKeyPath: join(root, "trust.pem"),
	};
	writeFileSync(nativePreview.requestPath, JSON.stringify(request), { mode: 0o600 });
	writeFileSync(nativePreview.grantPath, JSON.stringify(grant), { mode: 0o600 });
	writeFileSync(nativePreview.trustedPublicKeyPath, keys.publicKey.export({ format: "pem", type: "spki" }), {
		mode: 0o600,
	});
	const draftProvider = {
		generate: vi.fn(async () => ({
			markdown: "## Worth Reading\n\n- [Invented](https://invalid.test/invented)\n",
			provider: request.provider,
			model: request.model,
			receiptId: "synthetic-result",
		})),
	};
	return { root, settings, request, nativePreview, draftProvider };
}

describe("native Life preview consumer", () => {
	it("prepares prompt-only argv and preserves exact private request bytes", async () => {
		const root = makeRoot();
		const settings = resolveLifeOrchestratorSettings({ projectRoot: root, homeRoot: root });
		const commands: string[][] = [];
		const result = await Effect.runPromise(
			prepareLifeDailyPrompt(settings, "synthetic-model").pipe(
				Effect.provideService(CommandRunner, {
					run: (command) =>
						Effect.sync(() => {
							commands.push([...command.args]);
							expect(command.env?.HOME).toBe(root);
							writeFileSync(command.args[command.args.indexOf("--prompt-output") + 1]!, "exact prompt\n", {
								mode: 0o600,
							});
							return new CommandRunResult({
								...command,
								args: [...command.args],
								command: "synthetic",
								status: "succeeded",
								stdout: "",
								stderr: "",
								exitCode: 0,
							});
						}),
				}),
			),
		);
		expect(commands).toHaveLength(1);
		expect(commands[0]).toContain("--prompt-output");
		expect(result.promptHash).toBe(hash("exact prompt\n"));
		expect(JSON.parse(readFileSync(result.requestPath, "utf8"))).toMatchObject({
			prompt: "exact prompt\n",
			model: "synthetic-model",
		});
	});
	it("uses signed native generation, preserves no-repeat state and binds the final review bytes", async () => {
		const fixture = inputs();
		const ledger = await Effect.runPromise(LifeReadingLedger.open(fixture.settings.paths.databasePath));
		await Effect.runPromise(
			ledger.upsertCandidates(
				[
					{
						url: "https://example.test/unseen",
						title: "Unseen",
						topic: "Systems",
						publishedAt: null,
						sourceName: "fixture",
						sourceKind: "rss",
						sourceId: null,
					},
				],
				new Date().toISOString(),
			),
		);
		ledger.close();
		const effect = runLifeDaily(fixture.settings, {
			publish: false,
			nativePreview: fixture.nativePreview,
			draftProvider: fixture.draftProvider,
		}).pipe(Effect.provideService(CommandRunner, noCommands));
		const result = await Effect.runPromise(effect);
		const markdown = readFileSync(result.briefPath, "utf8");
		const review = JSON.parse(readFileSync(`${result.briefPath}.review.json`, "utf8"));
		expect(result).toMatchObject({ published: false, selected: 1 });
		expect(markdown).toContain("https://example.test/unseen");
		expect(markdown).not.toContain("invalid.test");
		expect(review).toMatchObject({ status: "needs_review", markdown, artifactHash: hash(markdown) });
		expect(review.receipt.draftHash).not.toBe(review.artifactHash);
		expect(existsSync(canonicalLifeBriefPath(fixture.settings.paths.lifeDirectory, new Date()))).toBe(false);
		const reopened = await Effect.runPromise(LifeReadingLedger.open(fixture.settings.paths.databasePath));
		expect(await Effect.runPromise(reopened.counts())).toMatchObject({ available: 1, reserved: 0, delivered: 0 });
		reopened.close();
		await expect(Effect.runPromise(effect)).rejects.toThrow("consumed grant");
		expect(fixture.draftProvider.generate).toHaveBeenCalledTimes(1);
		expect(readFileSync(result.briefPath, "utf8")).toBe(markdown);
	});
	it("refuses native publication and changed prompt before provider use", async () => {
		const fixture = inputs();
		await expect(
			Effect.runPromise(
				runLifeDaily(fixture.settings, {
					nativePreview: fixture.nativePreview,
					draftProvider: fixture.draftProvider,
				}).pipe(Effect.provideService(CommandRunner, noCommands)),
			),
		).rejects.toThrow("preview-only");
		writeFileSync(fixture.nativePreview.requestPath, JSON.stringify({ ...fixture.request, prompt: "changed" }));
		await expect(
			Effect.runPromise(
				runLifeDaily(fixture.settings, {
					publish: false,
					nativePreview: fixture.nativePreview,
					draftProvider: fixture.draftProvider,
				}).pipe(Effect.provideService(CommandRunner, noCommands)),
			),
		).rejects.toThrow("generation failed");
		expect(fixture.draftProvider.generate).not.toHaveBeenCalled();
	});
	it("preserves a consumed grant and original draft when hygiene fails", async () => {
		const fixture = inputs();
		const run = () =>
			Effect.runPromise(
				runLifeDaily(fixture.settings, {
					publish: false,
					nativePreview: fixture.nativePreview,
					draftProvider: fixture.draftProvider,
				}).pipe(
					Effect.provideService(CommandRunner, {
						run: (command) =>
							Effect.succeed(
								new CommandRunResult({
									...command,
									args: [...command.args],
									command: "synthetic hygiene failure",
									status: "failed",
									stdout: "",
									stderr: "synthetic cleanup failure",
									exitCode: 2,
								}),
							),
					}),
				),
			);
		await expect(run()).rejects.toThrow("text hygiene");
		await expect(run()).rejects.toThrow("consumed grant");
		expect(fixture.draftProvider.generate).toHaveBeenCalledTimes(1);
		const stem = `${new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())}-${hash(fixture.request.runId)}.md`;
		expect(existsSync(join(fixture.settings.paths.reviewDirectory, `${stem}.generated.md.json`))).toBe(true);
		expect(existsSync(join(fixture.settings.paths.reviewDirectory, `${stem}.review.json`))).toBe(false);
	});
	it("prompt-only script does not synthesize, clean, publish, notify or overwrite", () => {
		const root = makeRoot();
		const adapter = fileURLToPath(
			new URL(
				"../../capability-harnessy-v1-full/resources/flow-install/skills/life-orchestrator/scripts/daily-brief",
				import.meta.url,
			),
		);
		const wrapper = join(root, "fixture.py");
		const output = join(root, "prompt.txt");
		mkdirSync(join(root, "life"));
		writeFileSync(
			wrapper,
			`import os, runpy, sys, types\nfrom unittest.mock import Mock\nmodule=types.ModuleType('ai_runner')\nmodule.format_failure=Mock(side_effect=AssertionError('AI forbidden'))\nmodule.run_ai_prompt=Mock(side_effect=AssertionError('AI forbidden'))\nsys.modules['ai_runner']=module\nscript=runpy.run_path(sys.argv[1])\ng=script['main'].__globals__\ng['run_collect_state']=Mock(return_value={'priorities': {'raw': 'Synthetic priorities'}})\nfor name in ['call_ai','clean_text_hygiene','jarvis_journal','send_notification','mark_journal_delivered','save_brief']:\n    g[name]=Mock(side_effect=AssertionError(name+' forbidden'))\nsys.argv=['daily-brief','--date','2030-01-01','--prompt-output',sys.argv[2]]\nscript['main']()\ng['run_collect_state'].assert_called_once_with(no_save=True)\n`,
		);
		const invoke = () =>
			spawnSync("python3", ["-B", wrapper, adapter, output], {
				encoding: "utf8",
				env: {
					PATH: process.env.PATH,
					FLOW_PROJECT_ROOT: root,
					AGENTS_LIFE_DIR: join(root, "life"),
					PYTHONDONTWRITEBYTECODE: "1",
				},
			});
		const first = invoke();
		expect(first.status, first.stderr).toBe(0);
		const prompt = readFileSync(output, "utf8");
		expect(prompt).toContain("Synthetic priorities");
		expect(invoke().status).not.toBe(0);
		expect(readFileSync(output, "utf8")).toBe(prompt);
	});
});
