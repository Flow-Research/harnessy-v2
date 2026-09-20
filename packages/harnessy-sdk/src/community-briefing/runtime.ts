import { type BigIntStats, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	type CommunityBriefingWriteGrant,
	validateCommunityBriefingWriteGrant,
} from "@harnessy/core/community-briefing";
import { meetingPublicationDirectoryChain } from "@harnessy/core/meeting-publication";
import { Effect, Layer } from "effect";
import { engineToolAddress } from "../engine/compose.ts";
import { makeHarnessyEngine } from "../engine.ts";
import {
	engineCommunityBriefingDiscordLayer,
	engineCommunityBriefingGoogleLayer,
} from "../meeting-publication/providers.ts";
import { DISCORD_COMMUNITY_UPSERT_TOOL, DISCORD_MEETING_INTEGRATION } from "../plugins/discord-meeting-publication.ts";
import { GOOGLE_COMMUNITY_UPSERT_TOOL, GOOGLE_MEETING_INTEGRATION } from "../plugins/google-meeting-publication.ts";
import { CommunityBriefingQueue } from "./queue.ts";
import { publishClaimedCommunityBriefing } from "./worker.ts";

const startedGrants = new WeakSet<CommunityBriefingWriteGrant>();

/** Reuse the meeting host's canonical directory-chain checks; mutable databases
 * bind identity/permissions, not contents that legitimate checkpoints change. */
const bindRuntimePaths = (grant: CommunityBriefingWriteGrant): (() => void) => {
	const uid = process.geteuid?.();
	if (process.platform === "win32" || uid === undefined) throw new Error("community_unsupported_platform");
	const { queuePath, statePath, providerScope } = grant.binding;
	const directories = [
		statePath,
		providerScope.credentialDirectory,
		dirname(queuePath),
		dirname(providerScope.engineStatePath),
	];
	const inventory = new Map<string, BigIntStats>();
	for (const path of directories) {
		if (!isAbsolute(path) || resolve(path) !== path) throw new Error("community_unsafe_path");
		for (const [parent, stat] of meetingPublicationDirectoryChain(path, BigInt(uid))) inventory.set(parent, stat);
		const leaf = inventory.get(path)!;
		if (leaf.uid !== BigInt(uid) || (leaf.mode & 0o7777n) !== 0o700n) throw new Error("community_unsafe_path");
	}
	for (const path of [queuePath, providerScope.engineStatePath]) {
		const stat = lstatSync(path, { bigint: true });
		if (
			!isAbsolute(path) ||
			resolve(path) !== path ||
			realpathSync(path) !== path ||
			!stat.isFile() ||
			stat.nlink !== 1n ||
			stat.uid !== BigInt(uid) ||
			(stat.mode & 0o7777n) !== 0o600n
		)
			throw new Error("community_unsafe_path");
		inventory.set(path, stat);
	}
	return () => {
		for (const [path, before] of inventory) {
			const current = lstatSync(path, { bigint: true });
			if (
				realpathSync(path) !== path ||
				current.dev !== before.dev ||
				current.ino !== before.ino ||
				current.uid !== before.uid ||
				current.gid !== before.gid ||
				current.mode !== before.mode ||
				(current.isFile() && current.nlink !== 1n)
			)
				throw new Error("community_path_changed");
		}
		for (const suffix of ["-wal", "-shm", "-journal"]) {
			const path = `${queuePath}${suffix}`;
			const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
			if (stat === undefined) continue;
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.nlink !== 1n ||
				stat.uid !== BigInt(uid) ||
				(stat.mode & 0o7777n) !== 0o600n
			)
				throw new Error("community_unsafe_sidecar");
		}
		// Atomic credential rotation may replace the inode, but cannot redirect
		// reads or temporary writes outside the signed private directory.
		for (const name of ["auth.json", "auth.json.tmp"]) {
			const stat = lstatSync(join(providerScope.credentialDirectory, name), { bigint: true, throwIfNoEntry: false });
			if (stat === undefined && name === "auth.json.tmp") continue;
			if (
				stat === undefined ||
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.nlink !== 1n ||
				stat.uid !== BigInt(uid) ||
				(stat.mode & 0o7777n) !== 0o600n
			)
				throw new Error("community_unsafe_credentials");
		}
	};
};

/** One exact signed publication, using one privately captured existing Executor.
 * The operational caller must exclude compatibility writers before invoking this
 * boundary. It does not install schedules, provision connections or reclaim leases.
 */
export const runNativeCommunityBriefing = (grant: CommunityBriefingWriteGrant, clock: () => number = Date.now) =>
	Effect.scoped(
		Effect.gen(function* () {
			const verified = yield* validateCommunityBriefingWriteGrant(grant, "publish", grant.binding.item);
			const assertPaths = yield* Effect.try(() => bindRuntimePaths(verified));
			yield* Effect.try(() => {
				assertPaths();
				if (startedGrants.has(verified)) throw new Error("community_grant_already_started");
				startedGrants.add(verified);
			});
			const scope = verified.binding.providerScope;
			const handle = yield* makeHarnessyEngine({
				tenant: scope.tenantId,
				subject: scope.subjectId,
				credentialDirectory: scope.credentialDirectory,
				existingStatePath: scope.engineStatePath,
				onElicitation: () => Effect.succeed({ action: "decline" }),
				meetingProviderTransport:
					scope.transport.mode === "production"
						? { kind: "production" }
						: {
								kind: "test-loopback",
								googleDriveBaseUrl: scope.transport.googleDriveBaseUrl,
								googleDocsBaseUrl: scope.transport.googleDocsBaseUrl,
								discordBaseUrl: scope.transport.discordBaseUrl,
							},
			});
			const assertConnections = Effect.gen(function* () {
				for (const [integration, connection, tool] of [
					[GOOGLE_MEETING_INTEGRATION, scope.google, GOOGLE_COMMUNITY_UPSERT_TOOL],
					[DISCORD_MEETING_INTEGRATION, scope.discord, DISCORD_COMMUNITY_UPSERT_TOOL],
				] as const) {
					const connections = yield* handle.connections.list({ integration, owner: connection.owner });
					if (
						!connections.some(
							(value) => value.name === connection.connection && value.template === connection.authTemplate,
						)
					)
						return yield* Effect.fail(new Error("community_connection_mismatch"));
					const tools = yield* handle.tools.list({
						integration,
						owner: connection.owner,
						connection: connection.connection,
					});
					const address = engineToolAddress({
						integration,
						owner: connection.owner,
						connection: connection.connection,
						tool,
					});
					if (!tools.some((value) => value.address === address))
						return yield* Effect.fail(new Error("community_tool_unavailable"));
				}
			});
			yield* assertConnections;
			yield* Effect.try(assertPaths);
			const queue = yield* Effect.acquireRelease(
				Effect.try(() => new CommunityBriefingQueue(verified.binding.queuePath)),
				(value) => Effect.sync(() => value.close()),
			);
			yield* Effect.try(() => {
				if (queue.database.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().length !== 0)
					throw new Error("community_queue_trigger_rejected");
			});
			yield* Effect.try(assertPaths);
			yield* validateCommunityBriefingWriteGrant(verified, "publish", verified.binding.item);
			const item = yield* Effect.try(() => queue.claim(new Date(clock()).toISOString(), 600, verified.binding.item));
			if (item === null) return yield* Effect.fail(new Error("community_approved_item_unavailable"));
			const authorize = (current: CommunityBriefingWriteGrant) =>
				Effect.gen(function* () {
					if (current !== verified) return yield* Effect.fail(new Error("community_foreign_grant"));
					yield* assertConnections;
					yield* validateCommunityBriefingWriteGrant(current, "publish", verified.binding.item);
					yield* Effect.try(() => {
						assertPaths();
						queue.assertPublishableClaim(item, clock());
					});
				});
			return yield* publishClaimedCommunityBriefing(
				queue,
				item,
				verified,
				new Date(clock()).toISOString(),
				clock,
			).pipe(
				Effect.provide(
					Layer.merge(
						engineCommunityBriefingGoogleLayer({
							handle,
							authorize,
							owner: scope.google.owner,
							connection: scope.google.connection,
							expectedOwnerEmail: scope.google.ownerEmail,
							folderPath: scope.google.folderPath,
						}),
						engineCommunityBriefingDiscordLayer({
							handle,
							authorize,
							owner: scope.discord.owner,
							connection: scope.discord.connection,
							expectedChannelId: scope.discord.channelId,
						}),
					),
				),
			);
		}),
	);
