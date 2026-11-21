import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Command } from "effect/cli";
import { makeWorkCommand } from "../cli/work.ts";
import { REQUIRED_CLAUDE_FLAGS } from "../work/logic.ts";
import type { WorkDeps } from "../work/run.ts";
import { REVIEWED_COMMAND_ORACLE_DIGEST, reviewedCommandOracle } from "./command-oracle-manifest.ts";
import type { EngineeringJob } from "./contracts.ts";
import type { EvaluationBinding, EvaluationPlan } from "./evaluation.ts";
import type { ProtectedSemanticValidator } from "./evaluator-host.ts";
import { EngineeringStore, engineeringGrant } from "./store.ts";

export type HarnessyCommandProfile = "preparation-plan" | "local-status";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const active = (signal?: AbortSignal) => {
	if (signal?.aborted) throw new Error("Command workload cancelled");
};
const CLOCK = 10000;
async function fixtureBytes(path: string, signal?: AbortSignal): Promise<Buffer> {
	active(signal);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
			throw new Error("Unsafe bounded command fixture");
		const chunks: Buffer[] = [];
		let total = 0;
		for (;;) {
			active(signal);
			const chunk = Buffer.allocUnsafe(Math.min(65536, 1024 * 1024 + 1 - total));
			const { bytesRead } = await file.read(chunk);
			active(signal);
			if (!bytesRead) return Buffer.concat(chunks, total);
			total += bytesRead;
			if (total > 1024 * 1024) throw new Error("Command fixture byte limit exceeded");
			chunks.push(chunk.subarray(0, bytesRead));
		}
	} finally {
		await file.close();
	}
}
function assertSeedSemantics(path: string, state: string) {
	const database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
	try {
		const tables = database
			.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
			.all()
			.map((row) => String(row.name));
		const expectedTables = [
			"events",
			"grants",
			"host_cancellations",
			"host_delivery",
			"host_offers",
			"host_operations",
			"host_terminal_evidence",
			"jobs",
			"metadata",
			"objective_failures",
			"runs",
		];
		if (
			JSON.stringify(tables) !== JSON.stringify(expectedTables) ||
			Number(database.prepare("PRAGMA user_version").get()?.user_version) !== 3
		)
			throw new Error("Trusted status fixture schema differs from declared v3 ledger");
		const jobs = Number(database.prepare("SELECT COUNT(*) AS count FROM jobs").get()?.count);
		const grants = database.prepare("SELECT issued_at,expires_at,revoked_at FROM grants").all();
		if (
			jobs !== (state === "empty" ? 0 : 3) ||
			grants.length !== jobs ||
			grants.filter(
				(row) => row.revoked_at === null && Number(row.issued_at) <= CLOCK && Number(row.expires_at) > CLOCK,
			).length !== (state === "empty" ? 0 : 1)
		)
			throw new Error("Trusted status fixture approval/expiry/revocation rows differ");
		const runs = database.prepare("SELECT id,state,process_identity FROM runs").all();
		const active = !["empty", "approved"].includes(state);
		if (
			runs.length !== (active ? 1 : 0) ||
			(active &&
				(runs[0]?.id !== "fixture-run" ||
					runs[0]?.state !== state ||
					runs[0]?.process_identity !== (state === "reserved" ? null : "fixture-process")))
		)
			throw new Error("Trusted status fixture active run differs");
		const events = database.prepare("SELECT sequence,state FROM events ORDER BY sequence").all();
		const states = active
			? [
					"reserved",
					...(state === "reserved" ? [] : ["running"]),
					...(["cancel_requested", "reconciling"].includes(state) ? [state] : []),
				]
			: [];
		if (
			events.length !== states.length ||
			events.some((row, index) => Number(row.sequence) !== index + 1 || row.state !== states[index])
		)
			throw new Error("Trusted status fixture event sequence differs");
	} finally {
		database.close();
	}
}
interface CommandCase {
	readonly id: string;
	readonly args: ReadonlyArray<string>;
	readonly database?: string;
}
interface Transcript {
	readonly argv: ReadonlyArray<string>;
	readonly stdout: string;
}
const transcripts: ReadonlyArray<Transcript> = [
	{ argv: ["herdr", "--version"], stdout: "herdr 0.9.1\n" },
	{ argv: ["claude", "--version"], stdout: "3.1.0 (Claude Code)\n" },
	{ argv: ["claude", "--help"], stdout: REQUIRED_CLAUDE_FLAGS.join("\n") },
	{ argv: ["gh", "--version"], stdout: "gh version 2.65.0\n" },
	{ argv: ["git", "--version"], stdout: "git version 2.47.1\n" },
	{ argv: ["fixture-workstream", "--help"], stdout: "WorkStream fixture CLI\n" },
];

/** Fixed driver executes candidate command handlers. Only the host validates their results. */
export const HARNESSY_COMMAND_DRIVER = `"use strict";\nconst reviewedOracleDigest=${JSON.stringify(REVIEWED_COMMAND_ORACLE_DIGEST)};\n${String.raw`const fs=require("node:fs"),path=require("node:path"),{createRequire}=require("node:module");
const root=process.argv[2], input=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));
if(input.reviewedOracleDigest!==reviewedOracleDigest)throw Error("Unreviewed command oracle identity");
process.env.XDG_STATE_HOME=path.join(process.env.TMPDIR,"fixture-unused-xdg-state");
const requireSource=createRequire(path.join(root,"packages/harnessy-core/package.json"));
const {Effect,Console}=requireSource("effect"),{Command}=requireSource("effect/cli"),{NodeServices}=requireSource("@effect/platform-node");
const make=input.profile==="preparation-plan" ? require(path.join(root,"packages/harnessy-core/src/cli/work.ts")).makeWorkCommand : require(path.join(root,"packages/harnessy-core/src/cli/engineering.ts")).makeEngineeringCommand;
(async()=>{
 const operations=[];
 for(const test of input.cases){
  const logs=[],calls=[];
  const sink={...console,log:(...values)=>{const text=values.map(String).join(" ");if(text.length>131072||logs.length>32)throw Error("CLI output exceeded fixture bound");logs.push(text);},error:()=>{},warn:()=>{}};
  const deps={platform:"darwin",now:()=>input.clock,sleep:async()=>{throw Error("Unexpected sleep");},uuid:()=>"22222222-2222-4222-8222-222222222222",log:()=>{},stateRoot:"/fixture/state",managedSettingsPaths:[],notify:async()=>{throw Error("Unexpected notification");},run:async(argv)=>{calls.push(argv);const fixture=input.transcripts.find(x=>JSON.stringify(x.argv)===JSON.stringify(argv));if(!fixture)throw Error("Unexpected external command");return {exitCode:0,stdout:fixture.stdout,stderr:""};}};
  const command=input.profile==="preparation-plan"?make(()=>deps):make(()=>path.join(process.env.TMPDIR,test.database),()=>input.clock);
  const args=input.profile==="local-status"?[...test.args,"--database",path.join(process.env.TMPDIR,test.database)]:test.args;
  let result;
  try{await Effect.runPromise(Command.runWith(command,{version:"fixture"})(args).pipe(Effect.provide(NodeServices.layer),Effect.provideService(Console.Console,sink)));result={logs:logs.map(x=>JSON.parse(x)),calls,exitCode:process.exitCode??0};}
  catch(error){result={error:true,calls,...(input.profile==="local-status"?{detail:String(error).slice(0,300)}:{})};}
  process.exitCode=0;
  operations.push({caseId:test.id,result});
 }
 process.stdout.write(JSON.stringify({schema:"harnessy.engineering.command-output.v1",profile:input.profile,operations})+"\n");
})().catch(()=>{process.stderr.write("Fixed command workload failed\n");process.exitCode=1;});
`}`;

export interface HarnessyCommandWorkload {
	readonly profile: HarnessyCommandProfile;
	readonly scope: string;
	readonly input: string;
	readonly inputDigest: string;
	readonly driverDigest: string;
	readonly expectedDigest: string;
	readonly completedWork: number;
	readonly cases: ReadonlyArray<string>;
	readonly validateOutput: ProtectedSemanticValidator;
	readonly prepareScratch: (scratch: string) => Promise<void>;
	readonly validateScratch: (scratch: string) => Promise<void>;
	readonly observeFixtures: () => Promise<string>;
}

export async function createHarnessyCommandWorkload(
	profile: HarnessyCommandProfile,
	fixtureRoot: string,
	signal?: AbortSignal,
): Promise<HarnessyCommandWorkload> {
	active(signal);
	if (!["preparation-plan", "local-status"].includes(profile)) throw new Error("Unsupported direct command workload");
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	const reviewedOracle = reviewedCommandOracle(profile, extension);
	// Verify every semantic source before creating any fixture or issuing a seed.
	const verifiedSources: Array<{ original: string; copyName: string; bytes: Buffer; digest: string; mode: number }> =
		[];
	for (const source of reviewedOracle.files) {
		active(signal);
		const original = fileURLToPath(new URL(`../${source.name}.${extension}`, import.meta.url));
		const data = await fixtureBytes(original, signal);
		if (sha(data) !== source.digest) throw new Error(`Unreviewed command oracle source: ${source.name}`);
		verifiedSources.push({
			original,
			copyName: `${source.name.replaceAll("/", "__")}.${extension}`,
			bytes: data,
			digest: source.digest,
			mode: (await lstat(original)).mode & 0o777,
		});
	}
	active(signal);
	await mkdir(fixtureRoot, { mode: 0o700 });
	const cases: CommandCase[] = [];
	const expected: Array<{ caseId: string; result: unknown }> = [];
	const seeds = new Map<string, { bytes: Buffer; digest: string; postBytes: Buffer; postDigest: string }>();
	const oracleSources: Array<{ original: string; copy: string; digest: string; mode: number }> = [];
	const sqliteVersion = process.versions.sqlite;
	const oracleRoot = join(fixtureRoot, "oracle");
	await mkdir(oracleRoot, { mode: 0o700 });
	for (const source of verifiedSources) {
		active(signal);
		const copy = join(oracleRoot, source.copyName);
		await writeFile(copy, source.bytes, { flag: "wx", mode: 0o400 });
		oracleSources.push({ original: source.original, copy, digest: source.digest, mode: source.mode });
	}

	if (profile === "preparation-plan") {
		const task = "11111111-2222-4333-8444-555555555555";
		const base = [
			"--task",
			task,
			"--repo",
			"/fixture/repository",
			"--workstream-cli",
			"fixture-workstream",
			"--dry-run",
			"--json",
		];
		const variations: ReadonlyArray<ReadonlyArray<string>> = [
			[],
			["--base", "main"],
			["--base", "release-α"],
			["--max-minutes", "20"],
			["--agent-allow", "Bash(npm test *)"],
			["--agent-deps", "clone"],
			["--task-url", "https://example.invalid/task"],
			["--notify", "off"],
			["--budget-usd", "0"],
			["--max-minutes", "0"],
			["--merge-wait-hours", "0"],
			["--outcome-wait-hours", "-1"],
			["--agent-allow", "Bash(*)"],
			["--agent-allow", "malformed"],
			["--revise", " "],
			[],
		];
		for (const [index, variation] of variations.entries()) {
			active(signal);
			const test = {
				id: `preparation-${index}`,
				args: [
					...base.map((value, position) => (index === 15 && position === 1 ? "malformed-task-id" : value)),
					...variation,
				],
			};
			cases.push(test);
			const logs: unknown[] = [],
				calls: ReadonlyArray<string>[] = [];
			const sink: Console.Console = {
				...console,
				log: (...values: ReadonlyArray<unknown>) => {
					logs.push(JSON.parse(values.map(String).join(" ")));
				},
				error: () => {},
				warn: () => {},
			};
			const deps: WorkDeps = {
				platform: "darwin",
				now: () => CLOCK,
				sleep: async () => {
					throw new Error("Unexpected preparation sleep");
				},
				uuid: () => "22222222-2222-4222-8222-222222222222",
				log: () => {},
				stateRoot: "/fixture/state",
				managedSettingsPaths: [],
				notify: async () => {
					throw new Error("Unexpected preparation notification");
				},
				run: async (argv) => {
					calls.push([...argv]);
					const fixture = transcripts.find((value) => JSON.stringify(value.argv) === JSON.stringify(argv));
					if (!fixture) throw new Error("Unexpected preparation command");
					return { exitCode: 0, stdout: fixture.stdout, stderr: "" };
				},
			};
			const previousExit = process.exitCode;
			const result = await Effect.runPromise(
				Command.runWith(
					makeWorkCommand(() => deps),
					{ version: "fixture" },
				)(test.args).pipe(Effect.provide(NodeServices.layer), Effect.provideService(Console.Console, sink)),
				{ signal },
			)
				.then(
					() => ({ logs, calls, exitCode: process.exitCode ?? 0 }),
					() => ({ error: true, calls }),
				)
				.finally(() => {
					process.exitCode = previousExit;
				});
			if (
				index < 8
					? !("logs" in result) ||
						result.logs.length !== 1 ||
						(result.logs[0] as { status?: string }).status !== "dry_run" ||
						calls.length !== 6
					: !("error" in result)
			)
				throw new Error("Trusted preparation fixture does not satisfy its declared semantics");
			expected.push({ caseId: test.id, result });
		}
	} else {
		for (const state of ["empty", "approved", "reserved", "running", "cancel_requested", "reconciling"] as const) {
			active(signal);
			const directory = join(fixtureRoot, state);
			await mkdir(directory, { mode: 0o700 });
			const path = join(directory, "state.sqlite");
			const store = new EngineeringStore(path);
			try {
				if (state !== "empty") {
					const jobs: EngineeringJob[] = Array.from({ length: 3 }, (_, index) => ({
						schema: "harnessy.engineering.job.v1",
						id: randomUUID(),
						objective: `fixture-${index}`,
						taskId: randomUUID(),
						taskRevision: "f".repeat(64),
						workspace: "julian",
						repository: "harnessy-v2",
						lane: "native",
						sourceRevision: "a".repeat(40),
						evaluatorDigest: "b".repeat(64),
						workloadDigest: "c".repeat(64),
					}));
					const grants = jobs.map((job, index) => engineeringGrant(job, 1000, index === 1 ? 2000 : 1000000));
					for (const [index, job] of jobs.entries()) store.approve(job, grants[index], 1000);
					store.revoke(grants[2].id, 1001);
					if (state !== "approved") {
						const run = "fixture-run";
						store.reserve(jobs[0].id, grants[0].id, run, 1100);
						if (state !== "reserved") {
							store.start(run, 1101, "fixture-owner");
							store.bindProcess(run, "fixture-process", 1102);
						}
						if (state === "cancel_requested") store.requestCancellation(run, 1103);
						if (state === "reconciling") store.markUncertain(run, "Fixture uncertainty", 1103);
					}
				}
				for (const [operation, args] of [
					["status", ["status"]],
					["events", ["events"]],
					["cursor", ["events", "--after", "1"]],
				] as const) {
					const id = `${state}-${operation}`,
						database = `${id}/state.sqlite`;
					cases.push({ id, args, database });
					const value =
						operation === "status"
							? {
									schema: "harnessy.engineering.status.v1",
									observedAt: CLOCK,
									activeRun: store.active() ?? null,
									approvedJobs: store.approvedJobs(CLOCK),
									notice:
										"Local controller state only. Host availability and termination require live observation.",
								}
							: {
									schema: "harnessy.engineering.events.v1",
									events: store.events(operation === "cursor" ? 1 : 0),
								};
					expected.push({ caseId: id, result: { logs: [value], calls: [], exitCode: 0 } });
				}
			} finally {
				store.close();
			}
			assertSeedSemantics(path, state);
			const data = await fixtureBytes(path, signal);
			if (data.length > 1024 * 1024) throw new Error("Fixture database exceeded its byte limit");
			await chmod(path, 0o400);
			// The current store updates SQLite bookkeeping during open. Pin the exact legitimate post-image.
			const postPath = join(directory, "expected.sqlite");
			await writeFile(postPath, data, { flag: "wx", mode: 0o600 });
			active(signal);
			new EngineeringStore(postPath).close();
			active(signal);
			const postBytes = await fixtureBytes(postPath, signal);
			await chmod(postPath, 0o400);
			seeds.set(state, { bytes: data, digest: sha(data), postBytes, postDigest: sha(postBytes) });
		}
	}
	const input = JSON.stringify({
		schema: "harnessy.engineering.command-input.v1",
		reviewedOracleDigest: reviewedOracle.digest,
		reviewedOracleRevision: reviewedOracle.revision,
		profile,
		clock: CLOCK,
		cases,
		transcripts: profile === "preparation-plan" ? transcripts : [],
		seeds: [...seeds].map(([state, value]) => ({ state, digest: value.digest, bytes: value.bytes.length })),
	});
	const expectedOutput = JSON.stringify({
		schema: "harnessy.engineering.command-output.v1",
		profile,
		operations: expected,
	});
	const expectedDigest = sha(expectedOutput);
	const validateOutput: ProtectedSemanticValidator = (stdout) => {
		if (Buffer.byteLength(stdout) > 1024 * 1024)
			throw new Error("Actual command output exceeded its protected bound");
		if (sha(stdout.trim()) !== expectedDigest) {
			const observed: { operations?: Array<{ caseId?: string; result?: unknown }> } = JSON.parse(stdout);
			const index = expected.findIndex(
				(operation, position) => JSON.stringify(operation) !== JSON.stringify(observed.operations?.[position]),
			);
			throw new Error("Actual command outputs differ from protected fixture semantics", {
				cause: { profile, caseId: expected[index]?.caseId, observed: observed.operations?.[index] },
			});
		}
		return {
			outputDigest: expectedDigest,
			completedCases: cases.map((test) => test.id),
			completedWork: cases.length,
		};
	};
	const prepareScratch = async (scratch: string) => {
		for (const test of cases)
			if (test.database) {
				active(signal);
				const state = test.id.slice(0, test.id.lastIndexOf("-"));
				const seed = seeds.get(state);
				if (!seed) throw new Error("Missing controller fixture seed");
				await mkdir(join(scratch, test.id), { mode: 0o700 });
				await writeFile(join(scratch, test.database), seed.bytes, { flag: "wx", mode: 0o600 });
			}
	};
	const validateScratch = async (scratch: string) => {
		active(signal);
		if (
			JSON.stringify((await readdir(scratch)).sort()) !==
			JSON.stringify(
				cases
					.filter((test) => test.database)
					.map((test) => test.id)
					.sort(),
			)
		)
			throw new Error("Command scratch inventory changed");
		for (const test of cases)
			if (test.database) {
				active(signal);
				const directory = join(scratch, test.id);
				const directoryStat = await lstat(directory);
				if (
					!directoryStat.isDirectory() ||
					(await realpath(directory)) !== directory ||
					(directoryStat.mode & 0o077) !== 0 ||
					directoryStat.uid !== process.getuid?.()
				)
					throw new Error("Unsafe command fixture directory");
				const path = join(scratch, test.database),
					stat = await lstat(path);
				if (
					!stat.isFile() ||
					stat.nlink !== 1 ||
					stat.size > 1024 * 1024 ||
					(stat.mode & 0o777) !== 0o600 ||
					stat.uid !== process.getuid?.()
				)
					throw new Error("Unsafe command fixture database");
				const data = await fixtureBytes(path, signal);
				const seed = seeds.get(test.id.slice(0, test.id.lastIndexOf("-")));
				if (
					!seed ||
					sha(data) !== seed.postDigest ||
					JSON.stringify(await readdir(join(scratch, test.id))) !== JSON.stringify(["state.sqlite"])
				)
					throw new Error("Command fixture state was modified");
			}
	};
	const observeFixtures = async () => {
		active(signal);
		if (JSON.stringify((await readdir(fixtureRoot)).sort()) !== JSON.stringify([...seeds.keys(), "oracle"].sort()))
			throw new Error("Controller fixture inventory changed");
		for (const [state, seed] of seeds) {
			active(signal);
			const directory = join(fixtureRoot, state);
			const directoryStat = await lstat(directory);
			if (
				!directoryStat.isDirectory() ||
				(await realpath(directory)) !== directory ||
				(directoryStat.mode & 0o077) !== 0 ||
				JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(["expected.sqlite", "state.sqlite"])
			)
				throw new Error("Controller fixture directory changed");
			const path = join(fixtureRoot, state, "state.sqlite");
			const stat = await lstat(path);
			if (
				!stat.isFile() ||
				stat.nlink !== 1 ||
				stat.size !== seed.bytes.length ||
				(stat.mode & 0o777) !== 0o400 ||
				stat.uid !== process.getuid?.() ||
				sha(await fixtureBytes(path, signal)) !== seed.digest
			)
				throw new Error("Controller fixture seed changed");
			const postPath = join(directory, "expected.sqlite");
			const postStat = await lstat(postPath);
			if (
				!postStat.isFile() ||
				postStat.nlink !== 1 ||
				postStat.size !== seed.postBytes.length ||
				(postStat.mode & 0o777) !== 0o400 ||
				postStat.uid !== process.getuid?.() ||
				sha(await fixtureBytes(postPath, signal)) !== seed.postDigest
			)
				throw new Error("Controller fixture post-image changed");
		}
		if (oracleSources.length) {
			const oracleRoot = join(fixtureRoot, "oracle");
			if (
				(await realpath(oracleRoot)) !== oracleRoot ||
				JSON.stringify((await readdir(oracleRoot)).sort()) !==
					JSON.stringify(oracleSources.map((source) => source.copy.split("/").at(-1)).sort())
			)
				throw new Error("Trusted status oracle inventory changed");
			for (const source of oracleSources) {
				active(signal);
				if (
					sha(await fixtureBytes(source.original, signal)) !== source.digest ||
					sha(await fixtureBytes(source.copy, signal)) !== source.digest ||
					((await lstat(source.original)).mode & 0o777) !== source.mode ||
					((await lstat(source.copy)).mode & 0o777) !== 0o400
				)
					throw new Error("Trusted status oracle source changed");
			}
			if (process.versions.sqlite !== sqliteVersion) throw new Error("Trusted SQLite runtime changed");
		}
		return sha(
			JSON.stringify({
				schema:
					profile === "local-status"
						? "harnessy.engineering.status-open-oracle.v1"
						: "harnessy.engineering.preparation-fixtures.v1",
				sqliteVersion,
				reviewedOracleDigest: reviewedOracle.digest,
				reviewedOracleRevision: reviewedOracle.revision,
				oracleSources,
				seeds: [...seeds].map(([state, seed]) => ({ state, digest: seed.digest, postDigest: seed.postDigest })),
			}),
		);
	};
	return Object.freeze({
		profile,
		scope:
			profile === "preparation-plan"
				? "Actual work CLI and runWork dry-run preparation-plan orchestration with fixed external tool transcripts. Not live tool admission, full preparation, startup, or provider qualification."
				: "Actual engineering command status/events over fresh disposable SQLite fixtures with versioned status-open-oracle.v1 exact expected bookkeeping post-images. Includes command construction and store opening/migration bookkeeping. Not byte-immutable/read-only SQLite I/O, root startup, remote freshness, or provider qualification.",
		input,
		inputDigest: sha(input),
		driverDigest: sha(HARNESSY_COMMAND_DRIVER),
		expectedDigest,
		completedWork: cases.length,
		cases: cases.map((test) => test.id),
		validateOutput,
		prepareScratch,
		validateScratch,
		observeFixtures,
	});
}

export function harnessyCommandPlan(binding: EvaluationBinding, workload: HarnessyCommandWorkload): EvaluationPlan {
	if (binding.workloadDigest !== workload.inputDigest || binding.evaluatorDigest !== workload.driverDigest)
		throw new Error("Command artifacts differ from approved workload");
	return {
		binding,
		requiredChecks: [
			{
				id: `harnessy-${workload.profile}`,
				argv: ["harnessy-pinned-commands", "check"],
				expectedOutputDigest: workload.expectedDigest,
				expectedCases: workload.cases,
			},
		],
		workload: {
			argv: ["harnessy-pinned-commands", "sample"],
			expectedOutputDigest: workload.expectedDigest,
			completedWork: workload.completedWork,
			samples: 10,
		},
		primary: { id: "tests.runtime", direction: "lower", method: "paired-t", minimumImprovement: 0.05 },
		guardrails: [
			{ id: "server.useful_throughput", direction: "higher", maximumRegression: 0.05 },
			{ id: "memory.peak_resident", direction: "lower", maximumRegression: 0.05 },
		],
		assumptions: { independentPairs: false, approximatelyNormalDifferences: false },
	};
}
