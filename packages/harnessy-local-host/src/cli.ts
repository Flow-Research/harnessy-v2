#!/usr/bin/env node

import {
	exportLocalHostPlan,
	inspectLocalHost,
	preflightLocalHostOffline,
	readLocalHostStatus,
	scanLocalHostDry,
} from "./application.ts";
import { readAndVerifyPlanEnvelope, readLocalHostConfig } from "./input.ts";
import { canonicalJson, formatPlanEnvelope } from "./schema.ts";

const COMMANDS = ["status", "inspect", "scan-dry", "offline-preflight", "export", "verify"] as const;
type Command = (typeof COMMANDS)[number];

class LocalHostCliError extends Error {
	readonly code: "invalid_command" | "invalid_arguments";

	constructor(code: LocalHostCliError["code"]) {
		super("Local-host command rejected");
		this.name = "LocalHostCliError";
		this.code = code;
	}
}

const isCommand = (value: string): value is Command => (COMMANDS as ReadonlyArray<string>).includes(value);

const parseOptions = (values: ReadonlyArray<string>) => {
	const options = new Map<string, string>();
	for (let index = 0; index < values.length; index += 2) {
		const name = values[index];
		const value = values[index + 1];
		if (name === undefined || value === undefined || !name.startsWith("--") || value.startsWith("--")) {
			throw new LocalHostCliError("invalid_arguments");
		}
		if (options.has(name)) throw new LocalHostCliError("invalid_arguments");
		options.set(name, value);
	}
	return options;
};

const exactOptionSet = (
	options: ReadonlyMap<string, string>,
	required: ReadonlyArray<string>,
	optional: ReadonlyArray<string>,
) => {
	for (const name of required) {
		if (!options.has(name)) throw new LocalHostCliError("invalid_arguments");
	}
	const allowed = new Set([...required, ...optional]);
	for (const name of options.keys()) {
		if (!allowed.has(name)) throw new LocalHostCliError("invalid_arguments");
	}
};

const parseSafeInteger = (value: string, minimum: number, maximum: number) => {
	if (!/^(0|[1-9]\d*)$/u.test(value)) throw new LocalHostCliError("invalid_arguments");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new LocalHostCliError("invalid_arguments");
	}
	return parsed;
};

const writeJson = (value: unknown) => process.stdout.write(`${canonicalJson(value)}\n`);

const run = async () => {
	const commandValue = process.argv[2] ?? "";
	if (!isCommand(commandValue)) throw new LocalHostCliError("invalid_command");
	const options = parseOptions(process.argv.slice(3));
	if (commandValue === "verify") {
		exactOptionSet(options, ["--receipt"], []);
		const envelope = readAndVerifyPlanEnvelope(options.get("--receipt") ?? "");
		writeJson({
			kind: "harnessy.local-host.verification",
			valid: true,
			activated: false,
			receiptSha256: envelope.receiptSha256,
		});
		return;
	}

	const exportRequired = ["--config", "--host-executable", "--future-activation-receipt", "--working-directory"];
	exactOptionSet(options, commandValue === "export" ? exportRequired : ["--config"], ["--now-ms", "--since-days"]);
	const nowMillis = options.has("--now-ms")
		? parseSafeInteger(options.get("--now-ms") ?? "", 0, 8_640_000_000_000_000)
		: Date.now();
	const sinceDays = options.has("--since-days")
		? parseSafeInteger(options.get("--since-days") ?? "", 1, 365)
		: undefined;
	if (commandValue === "export") {
		const envelope = await exportLocalHostPlan({
			nowMillis,
			sinceDays,
			configPath: options.get("--config") ?? "",
			hostExecutable: options.get("--host-executable") ?? "",
			futureActivationReceiptPath: options.get("--future-activation-receipt") ?? "",
			workingDirectory: options.get("--working-directory") ?? "",
		});
		process.stdout.write(formatPlanEnvelope(envelope));
		return;
	}
	const loaded = readLocalHostConfig(options.get("--config") ?? "");
	const input = { config: loaded.config, nowMillis, sinceDays };
	if (commandValue === "status") return writeJson(await readLocalHostStatus(input));
	if (commandValue === "inspect") return writeJson(await inspectLocalHost(input));
	if (commandValue === "scan-dry") return writeJson(await scanLocalHostDry(input));
	if (commandValue === "offline-preflight") return writeJson(await preflightLocalHostOffline(input));
};

run().catch((cause: unknown) => {
	const code =
		typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
			? cause.code
			: "read_only_operation_failed";
	process.stderr.write(`${canonicalJson({ error: "local_host_command_failed", code })}\n`);
	process.exitCode = 1;
});
