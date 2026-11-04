import { lstatSync } from "node:fs";
import { join } from "node:path";

import {
	meetingPublicationDirectoryChain,
	readStableMeetingPublicationSmokeFile,
} from "@harnessy/core/meeting-publication";
import { Schema } from "effect";

import { isSafeAbsoluteMeetingCommandPath } from "./meeting-command-input.ts";

const Id = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u)));
const Owner = Schema.Literals(["org", "user"]);
const Secret = Schema.String.pipe(Schema.check(Schema.isPattern(/^[!-~]{1,4096}$/u)));
const SetupInput = Schema.Struct({
	kind: Schema.Literal("harnessy.meeting-publication.connection-setup.v1"),
	statePath: Schema.String,
	tenant: Id,
	subject: Id,
	google: Schema.Struct({
		owner: Owner,
		name: Id,
		clientOwner: Owner,
		clientSlug: Id,
		expectedOwnerEmail: Schema.String.pipe(Schema.check(Schema.isPattern(/^[^\s@]{1,64}@[^\s@]{1,255}$/u))),
		clientId: Secret,
		clientSecret: Secret,
	}),
	discord: Schema.Struct({
		owner: Owner,
		name: Id,
		expectedChannelId: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{1,32}$/u))),
		token: Secret,
	}),
});

/** Reads only an explicit owner-private input file; no environment or argv credentials. */
export const readMeetingSetupInput = (args: ReadonlyArray<string>) => {
	try {
		const path = args[1];
		const uid = process.geteuid?.();
		if (args.length !== 2 || args[0] !== "--input" || path === undefined || uid === undefined) {
			throw new Error("invalid_input");
		}
		const file = readStableMeetingPublicationSmokeFile(path, BigInt(uid), "private", 16_384);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
		const input = Schema.decodeUnknownSync(SetupInput, { onExcessProperty: "error" })(JSON.parse(text));
		if (!isSafeAbsoluteMeetingCommandPath(input.statePath)) throw new Error("invalid_input");
		meetingPublicationDirectoryChain(input.statePath, BigInt(uid));
		const stat = lstatSync(input.statePath);
		if (stat.uid !== uid || (stat.mode & 0o7777) !== 0o700) throw new Error("invalid_input");
		return {
			config: {
				directory: join(input.statePath, "native-executor"),
				credentialDirectory: join(input.statePath, "native-credentials"),
				tenant: input.tenant,
				subject: input.subject,
				google: {
					owner: input.google.owner,
					name: input.google.name,
					clientOwner: input.google.clientOwner,
					clientSlug: input.google.clientSlug,
					expectedOwnerEmail: input.google.expectedOwnerEmail,
				},
				discord: {
					owner: input.discord.owner,
					name: input.discord.name,
					expectedChannelId: input.discord.expectedChannelId,
				},
			},
			googleClient: { clientId: input.google.clientId, clientSecret: input.google.clientSecret },
			discordToken: input.discord.token,
		};
	} catch {
		// Schema and filesystem errors may contain private values; never retain their cause.
		throw new Error("meeting_setup_input_invalid");
	}
};
