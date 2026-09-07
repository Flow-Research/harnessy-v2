import { isAbsolute, parse, resolve } from "node:path";

import type { MeetingPublicationSmokeRuntimeInput } from "@harnessy/core/meeting-publication";
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
