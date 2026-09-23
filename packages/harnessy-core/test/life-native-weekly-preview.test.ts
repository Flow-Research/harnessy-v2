import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLifeOrchestratorSettings } from "../src/jarvis/life-orchestrator/config.ts";
import { lifeDraftGrantPayload } from "../src/jarvis/life-orchestrator/draft-grant-host.ts";
import { prepareLifeWeeklyPrompt, runLifeWeekly } from "../src/jarvis/life-orchestrator/service.ts";
import { CommandRunner, CommandRunResult, type ExternalCommand } from "../src/runtime/command-runner.ts";

const roots: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const now = new Date("2030-12-29T12:00:00Z"); // Sunday prepares ISO 2031-W01.
const root = () => {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "life-weekly-test-")));
	roots.push(path);
	return path;
};
afterEach(() => {
	vi.unstubAllEnvs();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const result = (command: ExternalCommand, status: "succeeded" | "failed" = "succeeded") =>
	new CommandRunResult({
		...command,
		args: [...command.args],
		command: "isolated fixture",
		status,
		stdout: "",
		stderr: status === "failed" ? "synthetic failure" : "",
		exitCode: status === "failed" ? 2 : 0,
	});
function fixture() {
	const path = root();
	const settings = resolveLifeOrchestratorSettings({
		projectRoot: path,
		homeRoot: path,
		compatibilityRoot: join(path, "absent"),
	});
	const request = {
		runId: "weekly:2031-W01:synthetic",
		kind: "weekly",
		provider: "codex",
		model: "synthetic-model",
		prompt: "Synthetic weekly context",
	} as const;
	const authority = {
		grantId: "synthetic-weekly",
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
	const nativePreview = {
		requestPath: join(path, "request.json"),
		grantPath: join(path, "grant.json"),
		trustedPublicKeyPath: join(path, "trust.pem"),
	};
	writeFileSync(nativePreview.requestPath, JSON.stringify(request), { mode: 0o600 });
	writeFileSync(
		nativePreview.grantPath,
		JSON.stringify({
			issuer: "fixture",
			authority,
			signature: sign(null, Buffer.from(lifeDraftGrantPayload("fixture", authority)), keys.privateKey).toString(
				"base64",
			),
		}),
		{ mode: 0o600 },
	);
	writeFileSync(nativePreview.trustedPublicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }), {
		mode: 0o600,
	});
	const draftProvider = {
		generate: vi.fn(async () => ({
			markdown: "# Weekly plan\nRaw draft\n",
			provider: "codex",
			model: request.model,
			receiptId: "synthetic-receipt",
		})),
	};
	return {
		path,
		settings,
		request,
		authority,
		keys,
		nativePreview,
		draftProvider,
		options: { now, publish: false, nativePreview, draftProvider },
	};
}

describe("signed weekly Life draft consumer", () => {
	it("prepares with the real file-backed collector without reading owner state or starting commands", async () => {
		vi.stubEnv("HARNESSY_LIFE_V1_SCRIPTS", undefined);
		const path = root();
		const scripts = fileURLToPath(
			new URL(
				"../../capability-harnessy-v1-full/resources/flow-install/skills/life-orchestrator/scripts/",
				import.meta.url,
			),
		);
		const settings = resolveLifeOrchestratorSettings({
			projectRoot: path,
			homeRoot: path,
			user: "fixture",
		});
		expect(settings.paths.compatibilityScriptsDirectory).toBe(scripts.replace(/\/$/u, ""));
		const privateContext = join(path, ".jarvis", "context", "private", "fixture");
		mkdirSync(privateContext, { recursive: true });
		writeFileSync(join(privateContext, "priorities.md"), "# Priorities\nSynthetic collector canary\n");
		const guard = `import argparse,contextlib,datetime,hashlib,json,os,pkgutil,re,runpy,subprocess,sys,urllib.parse\nallowed=(${JSON.stringify(path)},${JSON.stringify(scripts)},os.path.dirname(os.__file__))\ndef guard(event,args):\n if event.startswith('socket.') or event in ('subprocess.Popen','os.system'): raise PermissionError('external boundary denied')\n if event in ('open','os.listdir','os.scandir') and isinstance(args[0],(str,bytes)):\n  p=os.path.realpath(os.fsdecode(args[0]))\n  if not any(p==r.rstrip('/') or p.startswith(r.rstrip('/')+'/') for r in allowed): raise PermissionError('owner state denied')\nsys.addaudithook(guard)\n`;
		const prepared = await Effect.runPromise(
			prepareLifeWeeklyPrompt(settings, "synthetic-model", now).pipe(
				Effect.provideService(CommandRunner, {
					run: (command) =>
						Effect.sync(() => {
							const args = [...command.args];
							if (args[0] === "-B") args[2] = guard + args[2];
							const child = spawnSync(command.executable, args, {
								cwd: path,
								encoding: "utf8",
								env: {
									PATH: process.env.PATH,
									FLOW_USER: "fixture",
									JARVIS_WIKIS_DIR: join(path, "wikis"),
									PYTHONDONTWRITEBYTECODE: "1",
									...command.env,
								},
							});
							expect(child.status, child.stderr).toBe(0);
							return result(command);
						}),
				}),
			),
		);
		const request = JSON.parse(readFileSync(prepared.requestPath, "utf8"));
		expect(request.prompt).toContain("Synthetic collector canary");
		expect(existsSync(join(settings.paths.lifeDirectory, ".last-crawl.json"))).toBe(false);
	});
	it.each(["collector", "builder", "empty"])(
		"stops preparation on %s failure without writing a request",
		async (failure) => {
			const path = root();
			const settings = resolveLifeOrchestratorSettings({ projectRoot: path, homeRoot: path });
			let calls = 0;
			await expect(
				Effect.runPromise(
					prepareLifeWeeklyPrompt(settings, "synthetic-model", now).pipe(
						Effect.provideService(CommandRunner, {
							run: (command) =>
								Effect.sync(() => {
									calls += 1;
									return result(
										command,
										failure === "collector" || (failure === "builder" && calls === 2)
											? "failed"
											: "succeeded",
									);
								}),
						}),
					),
				),
			).rejects.toThrow();
			expect(calls).toBe(failure === "collector" ? 1 : 2);
			for (const directory of readdirSync(settings.paths.reviewDirectory))
				expect(existsSync(join(settings.paths.reviewDirectory, directory, "request.json"))).toBe(false);
		},
	);
	it("runs the real bounded prompt builder, preserves complete collected state and rolls Sunday into ISO week-year", async () => {
		const path = root();
		const scripts = join(path, "scripts");
		mkdirSync(scripts);
		mkdirSync(join(path, "templates"));
		writeFileSync(join(path, "templates", "weekly-plan.md"), "# Weekly Plan\n## Decisions\n");
		// A synthetic collector at the external command boundary; real stdout-to-file wrapper and prompt builder.
		writeFileSync(
			join(scripts, "collect-state"),
			"import json,sys\nassert sys.argv[1:]==['--no-save']\nprint(json.dumps({'projects': ['full-state-canary', 'x'*20000]}))\n",
		);
		const settings = resolveLifeOrchestratorSettings({
			projectRoot: path,
			homeRoot: path,
			compatibilityRoot: scripts,
		});
		const builder = fileURLToPath(
			new URL(
				"../../capability-harnessy-v1-full/resources/flow-install/skills/life-orchestrator/scripts/prepare-weekly-prompt",
				import.meta.url,
			),
		);
		const commands: ExternalCommand[] = [];
		const prepared = await Effect.runPromise(
			prepareLifeWeeklyPrompt(settings, "synthetic-model", now).pipe(
				Effect.provideService(CommandRunner, {
					run: (command) =>
						Effect.sync(() => {
							commands.push(command);
							expect(command.env?.HOME).toBe(path);
							const args = [...command.args];
							if (basename(args[0]!) === "prepare-weekly-prompt") args[0] = builder;
							const child = spawnSync(command.executable, args, {
								cwd: path,
								encoding: "utf8",
								env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", ...command.env },
							});
							expect(child.status, child.stderr).toBe(0);
							return result(command);
						}),
				}),
			),
		);
		expect(commands).toHaveLength(2);
		expect(prepared.runId).toMatch(/^weekly:2031-W01:/);
		const request = JSON.parse(readFileSync(prepared.requestPath, "utf8"));
		expect(request.prompt).toContain("full-state-canary");
		expect(request.prompt).toContain("Week 01 of 2031");
		expect(prepared.promptHash).toBe(hash(request.prompt));
		expect(statSync(prepared.requestPath).mode & 0o777).toBe(0o600);
		expect(existsSync(join(settings.paths.lifeDirectory, ".last-crawl.json"))).toBe(false);
	});
	it("preserves canonical plan, raw receipt, cleaned final receipt, and refuses replay", async () => {
		const f = fixture();
		const canonical = join(f.settings.paths.lifeDirectory, "2030", "Dec", "week-01-plan.md");
		mkdirSync(join(f.settings.paths.lifeDirectory, "2030", "Dec"), { recursive: true });
		writeFileSync(canonical, "Existing canonical plan");
		const commands: ExternalCommand[] = [];
		const run = () =>
			Effect.runPromise(
				runLifeWeekly(f.settings, f.options).pipe(
					Effect.provideService(CommandRunner, {
						run: (command) =>
							Effect.sync(() => {
								commands.push(command);
								expect(command.executable).toBe("jarvis");
								expect(command.args.slice(0, 2)).toEqual(["text-hygiene", "clean"]);
								writeFileSync(command.args[2]!, "# Weekly plan\nClean draft\n");
								return result(command);
							}),
					}),
				),
			);
		const outcome = await run();
		expect(outcome).toMatchObject({ published: false, runId: f.request.runId });
		if (!outcome) throw new Error("Missing preview");
		const raw = JSON.parse(readFileSync(`${outcome.briefPath}.generated.md.json`, "utf8"));
		const final = JSON.parse(readFileSync(`${outcome.briefPath}.review.json`, "utf8"));
		expect(raw.markdown).toContain("Raw draft");
		expect(final.markdown).toContain("Clean draft");
		expect(final.receipt).toEqual(raw.receipt);
		expect(final.artifactHash).toBe(hash(final.markdown));
		expect(final.receipt.draftHash).toBe(hash(raw.markdown));
		expect(readFileSync(canonical, "utf8")).toBe("Existing canonical plan");
		await expect(run()).rejects.toThrow("Weekly run reserved");
		expect(f.draftProvider.generate).toHaveBeenCalledTimes(1);
		expect(commands).toHaveLength(1);
	});
	it.each(["kind", "runId", "prompt", "model"])(
		"rejects mismatched %s without provider calls or fallback",
		async (field) => {
			const f = fixture();
			writeFileSync(
				f.nativePreview.requestPath,
				JSON.stringify({ ...f.request, [field]: field === "kind" ? "daily" : "changed" }),
			);
			await expect(
				Effect.runPromise(
					runLifeWeekly(f.settings, f.options).pipe(
						Effect.provideService(CommandRunner, {
							run: () => {
								throw new Error("Command forbidden");
							},
						}),
					),
				),
			).rejects.toThrow();
			expect(f.draftProvider.generate).not.toHaveBeenCalled();
		},
	);
	it("refuses publication and unsigned preview before any external call", async () => {
		const f = fixture();
		for (const options of [{ ...f.options, publish: true }, { publish: false }]) {
			await expect(
				Effect.runPromise(
					runLifeWeekly(f.settings, options).pipe(
						Effect.provideService(CommandRunner, {
							run: () => {
								throw new Error("Command forbidden");
							},
						}),
					),
				),
			).rejects.toThrow();
		}
		expect(f.draftProvider.generate).not.toHaveBeenCalled();
	});
	it("keeps consumed authority and raw evidence after hygiene failure", async () => {
		const f = fixture();
		const run = () =>
			Effect.runPromise(
				runLifeWeekly(f.settings, f.options).pipe(
					Effect.provideService(CommandRunner, { run: (command) => Effect.succeed(result(command, "failed")) }),
				),
			);
		await expect(run()).rejects.toThrow("text hygiene");
		await expect(run()).rejects.toThrow("Weekly run reserved");
		expect(f.draftProvider.generate).toHaveBeenCalledTimes(1);
		const files = readdirSync(f.settings.paths.reviewDirectory, { recursive: true }).map(String);
		expect(files.some((name) => name.endsWith(".generated.md.json"))).toBe(true);
		expect(files.some((name) => name.endsWith(".review.json"))).toBe(false);
	});
	it("does not retry uncertain provider failure", async () => {
		const f = fixture();
		f.draftProvider.generate.mockRejectedValue(new Error("synthetic timeout"));
		const run = () =>
			Effect.runPromise(
				runLifeWeekly(f.settings, f.options).pipe(
					Effect.provideService(CommandRunner, {
						run: () => {
							throw new Error("Command forbidden");
						},
					}),
				),
			);
		await expect(run()).rejects.toThrow("consumed grant");
		await expect(run()).rejects.toThrow("Weekly run reserved");
		expect(f.draftProvider.generate).toHaveBeenCalledTimes(1);
	});
	it("rejects concurrent consumption while the first provider request is in flight", async () => {
		const f = fixture();
		let release!: () => void;
		let started!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.draftProvider.generate.mockImplementation(async () => {
			started();
			await hold;
			return { markdown: "# Weekly plan\n", provider: "codex", model: f.request.model, receiptId: "synthetic-held" };
		});
		const run = () =>
			Effect.runPromise(
				runLifeWeekly(f.settings, f.options).pipe(
					Effect.provideService(CommandRunner, { run: (command) => Effect.succeed(result(command)) }),
				),
			);
		const first = run();
		try {
			await entered;
			await expect(run()).rejects.toThrow("Weekly run reserved");
			const authority = { ...f.authority, grantId: "different-signed-grant-same-run" };
			writeFileSync(
				f.nativePreview.grantPath,
				JSON.stringify({
					issuer: "fixture",
					authority,
					signature: sign(
						null,
						Buffer.from(lifeDraftGrantPayload("fixture", authority)),
						f.keys.privateKey,
					).toString("base64"),
				}),
			);
			await expect(run()).rejects.toThrow("Weekly run reserved");
		} finally {
			release();
			await first;
		}
		expect(f.draftProvider.generate).toHaveBeenCalledTimes(1);
	});
	it("retains raw evidence but never creates a final review for empty cleaned output", async () => {
		const f = fixture();
		await expect(
			Effect.runPromise(
				runLifeWeekly(f.settings, f.options).pipe(
					Effect.provideService(CommandRunner, {
						run: (command) =>
							Effect.sync(() => {
								writeFileSync(command.args[2]!, " ");
								return result(command);
							}),
					}),
				),
			),
		).rejects.toThrow("save reviewed");
		const files = readdirSync(f.settings.paths.reviewDirectory, { recursive: true }).map(String);
		expect(files.some((name) => name.endsWith(".generated.md.json"))).toBe(true);
		expect(files.some((name) => name.endsWith(".review.json"))).toBe(false);
	});
	it("keeps raw evidence and refuses replay after interruption during hygiene", async () => {
		const f = fixture();
		let started!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const controller = new AbortController();
		const effect = runLifeWeekly(f.settings, f.options).pipe(
			Effect.provideService(CommandRunner, {
				run: () => Effect.sync(() => started()).pipe(Effect.andThen(Effect.never)),
			}),
		);
		const running = Effect.runPromise(effect, { signal: controller.signal });
		const rejected = expect(running).rejects.toThrow();
		await entered;
		controller.abort();
		await rejected;
		await expect(Effect.runPromise(effect)).rejects.toThrow("Weekly run reserved");
		expect(f.draftProvider.generate).toHaveBeenCalledTimes(1);
		const files = readdirSync(f.settings.paths.reviewDirectory, { recursive: true }).map(String);
		expect(files.some((name) => name.endsWith(".generated.md.json"))).toBe(true);
		expect(files.some((name) => name.endsWith(".review.json"))).toBe(false);
	});
});
