import { isAbsolute, parse, resolve } from "node:path";

import {
	type MeetingPublicationSmokeRuntimeInput,
	readStableMeetingPublicationSmokeFile,
} from "@harnessy/core/meeting-publication";
import { Schema } from "effect";
import * as Effect from "effect/Effect";

const required = [
	"--authorization",
	"--trusted-keyring",
	"--trusted-keyring-device",
	"--trusted-keyring-inode",
	"--trusted-keyring-sha256",
];

export const isSafeAbsoluteMeetingCommandPath = (value: string) =>
	value.length <= 4096 &&
	isAbsolute(value) &&
	resolve(value) === value &&
	parse(value).root !== value &&
	!Array.from(value).some((character) => {
		const point = character.codePointAt(0) ?? 0;
		return point <= 0x1f || point === 0x7f;
	});

export const isMeetingCommandSha256 = (value: string) => /^[a-f0-9]{64}$/u.test(value);

const savedServiceInput = (
	kind: "harnessy.meeting-publication.service-config.v1" | "harnessy.community.briefing.service-config.v1",
) =>
	Schema.Struct({
		kind: Schema.Literal(kind),
		authorizationPath: Schema.String,
		trustedKeyring: Schema.Struct({
			path: Schema.String,
			device: Schema.String,
			inode: Schema.String,
			sha256: Schema.String,
		}),
	});

/** Owner-private saved bindings, never discovered or inferred from an adjacent keyring. */
const parseSavedServiceInput = (
	path: string,
	kind: "harnessy.meeting-publication.service-config.v1" | "harnessy.community.briefing.service-config.v1",
): Effect.Effect<MeetingPublicationSmokeRuntimeInput, "invalid_arguments"> =>
	Effect.try({
		try: () => {
			const uid = process.geteuid?.();
			if (uid === undefined || !isSafeAbsoluteMeetingCommandPath(path)) throw new Error("invalid_input");
			const file = readStableMeetingPublicationSmokeFile(path, BigInt(uid), "private", 16_384);
			return Schema.decodeUnknownSync(savedServiceInput(kind), { onExcessProperty: "error" })(
				JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)),
			);
		},
		catch: () => "invalid_arguments" as const,
	}).pipe(
		Effect.flatMap((input) =>
			parseMeetingRuntimeCommandInput([
				"--authorization",
				input.authorizationPath,
				"--trusted-keyring",
				input.trustedKeyring.path,
				"--trusted-keyring-device",
				input.trustedKeyring.device,
				"--trusted-keyring-inode",
				input.trustedKeyring.inode,
				"--trusted-keyring-sha256",
				input.trustedKeyring.sha256,
			]),
		),
	);

export const parseSavedMeetingServiceInput = (path: string) =>
	parseSavedServiceInput(path, "harnessy.meeting-publication.service-config.v1");
export const parseSavedCommunityServiceInput = (path: string) =>
	parseSavedServiceInput(path, "harnessy.community.briefing.service-config.v1");

/** Source-private parser shared by the separately packaged guarded commands. */
export const parseMeetingRuntimeCommandInput = (
	args: ReadonlyArray<string>,
): Effect.Effect<MeetingPublicationSmokeRuntimeInput, "invalid_arguments"> =>
	Effect.gen(function* () {
		if (args.length !== required.length * 2) return yield* Effect.fail("invalid_arguments" as const);
		const options = new Map<string, string>();
		for (let index = 0; index < args.length; index += 2) {
			const name = args[index];
			const value = args[index + 1];
			if (
				name === undefined ||
				value === undefined ||
				!required.includes(name) ||
				options.has(name) ||
				value.length === 0 ||
				value.startsWith("--")
			) {
				return yield* Effect.fail("invalid_arguments" as const);
			}
			options.set(name, value);
		}
		const authorizationPath = options.get("--authorization") ?? "";
		const path = options.get("--trusted-keyring") ?? "";
		const device = options.get("--trusted-keyring-device") ?? "";
		const inode = options.get("--trusted-keyring-inode") ?? "";
		const sha256 = options.get("--trusted-keyring-sha256") ?? "";
		if (
			![authorizationPath, path].every(isSafeAbsoluteMeetingCommandPath) ||
			![device, inode].every((value) => /^(0|[1-9]\d{0,31})$/u.test(value)) ||
			!isMeetingCommandSha256(sha256)
		) {
			return yield* Effect.fail("invalid_arguments" as const);
		}
		return { authorizationPath, trustedKeyring: { path, device, inode, sha256 } };
	});
