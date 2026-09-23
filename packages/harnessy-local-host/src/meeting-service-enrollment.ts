import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
	encodeMeetingPublicationServiceEnrollmentRequest,
	meetingPublicationDirectoryChain,
	prepareMeetingPublicationServiceRequest,
	provisionMeetingPublicationService,
	readStableMeetingPublicationSmokeFile,
} from "@harnessy/core/meeting-publication";

import { isSafeAbsoluteMeetingCommandPath } from "./meeting-command-input.ts";
import { artifactAnchors } from "./meeting-runtime.ts";
import { signOwnerServiceRequest } from "./owner-service-signing.ts";

export const writeNewPrivateMeetingServiceFile = (path: string, text: string) => {
	const file = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		writeFileSync(file, text);
		fsyncSync(file);
	} finally {
		closeSync(file);
	}
	const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
};

/** Stage private service files only; activation belongs to the explicit OS control step. */
export const installMeetingServiceFiles = (directory: string, plist: string) => {
	const uid = process.geteuid?.();
	if (uid === undefined || !isSafeAbsoluteMeetingCommandPath(directory)) throw new Error("invalid_arguments");
	meetingPublicationDirectoryChain(directory, BigInt(uid));
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700 || readdirSync(directory).length !== 0)
		throw new Error("unsafe_output");
	writeNewPrivateMeetingServiceFile(join(directory, "stdout.log"), "");
	writeNewPrivateMeetingServiceFile(join(directory, "stderr.log"), "");
	writeNewPrivateMeetingServiceFile(join(directory, "org.harnessy.meeting-publication.plist"), plist);
	return { kind: "harnessy.meeting-publication.service-files-installed", activated: false } as const;
};

type MeetingLaunchctl = (args: ReadonlyArray<string>) => {
	readonly status: number | null;
	readonly stderr: string;
	readonly stdout?: string;
};
const runMeetingLaunchctl: MeetingLaunchctl = (args) => {
	const result = spawnSync("/bin/launchctl", [...args], {
		encoding: "utf8",
		shell: false,
		timeout: args[0] === "bootout" ? 55_000 : 10_000,
		maxBuffer: 64 * 1024,
	});
	if (result.error !== undefined || result.signal !== null) throw new Error("service_control_failed");
	return result;
};

/** bootout is asynchronous; wait for removal without blocking the control process. */
export const waitMeetingServiceStopped = async (launchctl: MeetingLaunchctl = runMeetingLaunchctl) => {
	const uid = process.geteuid?.();
	if (process.platform !== "darwin" || uid === undefined) throw new Error("invalid_arguments");
	const deadline = Date.now() + 50_000;
	do {
		const result = launchctl(["print", `gui/${uid}/org.harnessy.meeting-publication`]);
		if (result.status !== 0) {
			if (result.stderr.includes("Could not find service")) return;
			throw new Error("service_stop_unconfirmed");
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error("service_stop_unconfirmed");
};

/** Control only the exact staged service; runtime health is checked separately. */
export const controlMeetingServiceFiles = (
	directory: string,
	expectedPlist: string,
	launchctl: MeetingLaunchctl = runMeetingLaunchctl,
	action: "enable" | "disable" = "enable",
) => {
	const uid = process.geteuid?.();
	if (process.platform !== "darwin" || uid === undefined || !isSafeAbsoluteMeetingCommandPath(directory))
		throw new Error("invalid_arguments");
	meetingPublicationDirectoryChain(directory, BigInt(uid));
	const stat = lstatSync(directory);
	if (stat.uid !== uid || (stat.mode & 0o7777) !== 0o700) throw new Error("unsafe_output");
	const plistPath = join(directory, "org.harnessy.meeting-publication.plist");
	const file = readStableMeetingPublicationSmokeFile(plistPath, BigInt(uid), "private", 64 * 1024);
	if (file.bytes.toString("utf8") !== expectedPlist) throw new Error("service_configuration_changed");
	for (const name of ["stdout.log", "stderr.log"]) {
		const log = lstatSync(join(directory, name));
		if (!log.isFile() || log.nlink !== 1 || log.uid !== uid || (log.mode & 0o7777) !== 0o600)
			throw new Error("unsafe_output");
	}
	const domain = `gui/${uid}`;
	const target = `${domain}/org.harnessy.meeting-publication`;
	const existing = launchctl(["print", target]);
	if (action === "disable") {
		if (existing.status === 0) {
			// Fail closed on unknown launchctl output; never stop a same-label job
			// loaded from another installation.
			const paths = (existing.stdout ?? "")
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.startsWith("path = "));
			if (paths.length !== 1 || paths[0] !== `path = ${plistPath}`) throw new Error("service_configuration_changed");
		} else if (!existing.stderr.includes("Could not find service"))
			throw new Error("service_already_loaded_or_unknown");
		if (launchctl(["disable", target]).status !== 0) throw new Error("service_control_failed");
		if (existing.status === 0 && launchctl(["bootout", target]).status !== 0)
			throw new Error("service_control_failed");
		return { kind: "harnessy.meeting-publication.service-stop-submitted", runtimeHealth: "not_assessed" } as const;
	}
	if (existing.status === 0 || !existing.stderr.includes("Could not find service"))
		throw new Error("service_already_loaded_or_unknown");
	for (const args of [
		["enable", target],
		["bootstrap", domain, plistPath],
	]) {
		if (launchctl(args).status !== 0) throw new Error("service_control_failed");
	}
	return { kind: "harnessy.meeting-publication.service-start-submitted", runtimeHealth: "not_assessed" } as const;
};

/** Explicit setup: empty-state provisioning or separately discriminated existing-trust adoption. */
export const setupMeetingService = (args: ReadonlyArray<string>) => {
	const path = args[1];
	const uid = process.geteuid?.();
	if (
		args.length !== 2 ||
		args[0] !== "--input" ||
		!path ||
		!isSafeAbsoluteMeetingCommandPath(path) ||
		uid === undefined
	)
		throw new Error("invalid_arguments");
	const file = readStableMeetingPublicationSmokeFile(path, BigInt(uid), "private", 16_384);
	return provisionMeetingPublicationService(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)));
};

/** Build unsigned, reviewable bindings from configuration; no key or provider acquisition. */
export const prepareMeetingService = (args: ReadonlyArray<string>) => {
	if (
		args.length !== 4 ||
		args[0] !== "--input" ||
		args[2] !== "--output-directory" ||
		!args[1] ||
		!args[3] ||
		!isSafeAbsoluteMeetingCommandPath(args[1]) ||
		!isSafeAbsoluteMeetingCommandPath(args[3])
	)
		throw new Error("invalid_arguments");
	const uid = process.geteuid?.();
	if (uid === undefined) throw new Error("unsupported_platform");
	const input = readStableMeetingPublicationSmokeFile(args[1], BigInt(uid), "private");
	const configuration: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
	const prepared = prepareMeetingPublicationServiceRequest(configuration, args[3], artifactAnchors);
	writeNewPrivateMeetingServiceFile(join(args[3], "artifact-manifest.json"), prepared.manifest);
	writeNewPrivateMeetingServiceFile(join(args[3], "request.json"), prepared.request);
	writeNewPrivateMeetingServiceFile(
		join(args[3], "service.json"),
		`${JSON.stringify({
			kind: "harnessy.meeting-publication.service-config.v1",
			authorizationPath: join(args[3], "enrollment.json"),
			trustedKeyring: (configuration as { readonly trustedKeyring: unknown }).trustedKeyring,
		})}\n`,
	);
	return {
		kind: "harnessy.meeting-publication.service-request-prepared",
		activated: false,
		requestSha256: createHash("sha256").update(prepared.request).digest("hex"),
	} as const;
};

/** Explicit offline owner action. Never imported by the provider or authority runtime. */
export const enrollMeetingService = (args: ReadonlyArray<string>) => {
	const names = ["--request", "--request-sha256", "--owner-key", "--public-key-sha256", "--output"];
	const values = new Map<string, string>();
	if (args.length !== names.length * 2) throw new Error("invalid_arguments");
	for (let index = 0; index < args.length; index += 2) {
		const name = args[index];
		const value = args[index + 1];
		if (!name || !names.includes(name) || values.has(name) || !value) throw new Error("invalid_arguments");
		values.set(name, value);
	}
	const requestPath = values.get("--request")!;
	const keyPath = values.get("--owner-key")!;
	const outputPath = values.get("--output")!;
	if (
		![requestPath, keyPath, outputPath].every(isSafeAbsoluteMeetingCommandPath) ||
		![values.get("--request-sha256")!, values.get("--public-key-sha256")!].every((v) => /^[a-f0-9]{64}$/u.test(v)) ||
		new Set([requestPath, keyPath, outputPath]).size !== 3
	)
		throw new Error("invalid_arguments");
	const uid = process.geteuid?.();
	if (uid === undefined) throw new Error("unsupported_platform");
	const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
	const request = readStableMeetingPublicationSmokeFile(requestPath, BigInt(uid), "private");
	if (hash(request.bytes) !== values.get("--request-sha256")) throw new Error("request_changed");
	const text = new TextDecoder("utf-8", { fatal: true }).decode(request.bytes);
	const encoded = encodeMeetingPublicationServiceEnrollmentRequest(JSON.parse(text));
	if (`${encoded.canonical}\n` !== text || encoded.payload.runtime.uid !== String(uid))
		throw new Error("invalid_request");
	const manifest = readStableMeetingPublicationSmokeFile(
		encoded.payload.artifactManifest.path,
		BigInt(uid),
		"artifact",
		32 * 1024 * 1024,
	);
	if (hash(manifest.bytes) !== encoded.payload.artifactManifest.sha256) throw new Error("artifact_changed");
	const inventory: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes));
	if (
		typeof inventory !== "object" ||
		inventory === null ||
		!("root" in inventory) ||
		typeof inventory.root !== "string" ||
		!isSafeAbsoluteMeetingCommandPath(inventory.root)
	)
		throw new Error("invalid_manifest");
	for (const directory of [
		inventory.root,
		encoded.payload.config.sourcePath,
		encoded.payload.config.statePath,
		encoded.payload.credentials.directory,
	]) {
		if (directory === null) throw new Error("invalid_request");
		const keyRelative = relative(directory, keyPath);
		if (
			keyRelative === "" ||
			(!isAbsolute(keyRelative) && keyRelative !== ".." && !keyRelative.startsWith(`..${sep}`))
		)
			throw new Error("key_inside_runtime");
	}
	const parent = dirname(outputPath);
	meetingPublicationDirectoryChain(parent, BigInt(uid));
	const parentStat = lstatSync(parent);
	if (parentStat.uid !== uid || (parentStat.mode & 0o7777) !== 0o700) throw new Error("unsafe_output");
	const signature = signOwnerServiceRequest(
		keyPath,
		values.get("--public-key-sha256")!,
		encoded.signingBytes,
	).toString("base64url");
	// Exclusive creation preserves existing enrollments and inputs. A failed write
	// is deliberately not retried or deleted; the owner must inspect that output.
	writeNewPrivateMeetingServiceFile(
		outputPath,
		`{"payload":${encoded.canonical},"signature":${JSON.stringify(signature)}}\n`,
	);
	return { kind: "harnessy.meeting-publication.service-enrollment-created", activated: false } as const;
};
