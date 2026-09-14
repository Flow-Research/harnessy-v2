import {
	type AnyPlugin,
	AuthTemplateSlug,
	ConnectionName,
	type Executor,
	IntegrationSlug,
	OAuthCompleteError,
	ToolAddress,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";

import { withMeetingPublicationMutationGuard } from "../meeting-publication/mutation-guard.ts";
import {
	GOOGLE_MEETING_AUTH_TEMPLATE,
	GOOGLE_MEETING_INTEGRATION,
	GOOGLE_MEETING_PREFLIGHT_TOOL,
} from "../plugins/google-meeting-publication.ts";
import {
	EngineConnection,
	EngineHealth,
	EngineIntegration,
	EngineMeetingReconnectError,
	type EngineMeetingReconnectSession,
	EnginePolicyDecision,
	EngineTool,
	type HarnessyEngineHandle,
} from "./compose.ts";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isMeetingMutationAddress = (address: string): boolean => {
	const parts = address.split(".");
	return (
		parts.length === 5 &&
		parts[0] === "tools" &&
		(parts[1] === "google-meeting-publication" || parts[1] === "discord-meeting-publication") &&
		(parts[2] === "org" || parts[2] === "user") &&
		parts[3] !== "" &&
		parts[4] === "upsert"
	);
};

class EngineMeetingApprovalRejected extends Schema.TaggedErrorClass<EngineMeetingApprovalRejected>()(
	"EngineMeetingApprovalRejected",
	{},
) {
	override get message(): string {
		return "Scoped meeting publication approval was rejected.";
	}
}

const meetingProofMatches = (
	address: string,
	args: unknown,
	approval: { readonly itemId: string; readonly sourceHash: string },
) =>
	isMeetingMutationAddress(address) &&
	isRecord(args) &&
	args.itemId === approval.itemId &&
	args.sourceHash === approval.sourceHash;

/** Confine the vendored Executor type graph to the Node composition boundary. */
export const harnessyEngineHandle = <TPlugins extends readonly AnyPlugin[]>(
	executor: Executor<TPlugins>,
): HarnessyEngineHandle => ({
	execute: (address, args) => executor.execute(ToolAddress.make(address), args),
	executeApprovedMeetingMutation: (address, args, approval) =>
		meetingProofMatches(address, args, approval)
			? executor.execute(ToolAddress.make(address), args, {
					onElicitation: (context) => {
						const approved =
							context.request._tag === "FormElicitation" &&
							String(context.address) === address &&
							meetingProofMatches(address, context.args, approval);
						return Effect.succeed({ action: approved ? "accept" : "decline" });
					},
				})
			: Effect.fail(new EngineMeetingApprovalRejected()),
	connections: {
		startGoogleMeetingReconnect: (input, guard) =>
			Effect.gen(function* () {
				const { owner, name, expectedOwnerEmail, redirectUri } = input;
				const authorize = (current: Effect.Effect<void, unknown>) =>
					current.pipe(Effect.mapError(() => new EngineMeetingReconnectError({ code: "invalid_grant" })));
				yield* authorize(guard);
				const callback = URL.canParse(redirectUri) ? new URL(redirectUri) : null;
				if (
					callback === null ||
					callback.protocol !== "http:" ||
					!["127.0.0.1", "[::1]"].includes(callback.hostname) ||
					callback.port === "" ||
					callback.username !== "" ||
					callback.password !== "" ||
					callback.search !== "" ||
					callback.hash !== "" ||
					redirectUri.length > 2_048 ||
					/[\u0000-\u0020\u007f]/u.test(redirectUri) ||
					!/^[a-zA-Z0-9_-]+$/u.test(name) ||
					name.length > 128 ||
					expectedOwnerEmail.trim() !== expectedOwnerEmail ||
					expectedOwnerEmail.length > 320 ||
					!expectedOwnerEmail.includes("@") ||
					/[\u0000-\u0020\u007f]/u.test(expectedOwnerEmail)
				)
					return yield* new EngineMeetingReconnectError({ code: "invalid_input" });
				const ref = {
					owner,
					integration: IntegrationSlug.make(GOOGLE_MEETING_INTEGRATION),
					name: ConnectionName.make(name),
				};
				const connection = yield* executor.connections
					.get(ref)
					.pipe(Effect.mapError(() => new EngineMeetingReconnectError({ code: "provider_unavailable" })));
				if (connection === null) return yield* new EngineMeetingReconnectError({ code: "missing_connection" });
				if (connection.oauthClient == null || connection.template !== GOOGLE_MEETING_AUTH_TEMPLATE)
					return yield* new EngineMeetingReconnectError({ code: "unsupported_connection" });
				const clientOwner = connection.oauthClientOwner ?? connection.owner;
				const clients = yield* executor.oauth
					.listClients()
					.pipe(Effect.mapError(() => new EngineMeetingReconnectError({ code: "provider_unavailable" })));
				if (
					!clients.some(
						(client) =>
							client.owner === clientOwner &&
							client.slug === connection.oauthClient &&
							client.grant === "authorization_code",
					)
				)
					return yield* new EngineMeetingReconnectError({ code: "unsupported_connection" });
				yield* authorize(guard);
				const started = yield* withMeetingPublicationMutationGuard(
					executor.oauth.start({
						client: connection.oauthClient,
						clientOwner,
						owner: connection.owner,
						name: connection.name,
						integration: connection.integration,
						template: connection.template,
						identityLabel: connection.identityLabel,
						redirectUri: callback.href,
					}),
					authorize(guard),
				).pipe(Effect.mapError(() => new EngineMeetingReconnectError({ code: "consent_failed" })));
				if (started.status !== "redirect")
					return yield* new EngineMeetingReconnectError({ code: "unsupported_connection" });
				let consumed = false;
				let inFlight = false;
				let cancelled = false;
				return Object.freeze({
					state: String(started.state),
					authorizationUrl: started.authorizationUrl,
					complete: (code, freshGuard) =>
						Effect.gen(function* () {
							if (
								consumed ||
								cancelled ||
								code.length === 0 ||
								code.length > 4_096 ||
								/[\u0000-\u0020\u007f]/u.test(code)
							)
								return yield* new EngineMeetingReconnectError({ code: "invalid_session" });
							consumed = true;
							inFlight = true;
							return yield* Effect.gen(function* () {
								yield* authorize(freshGuard);
								const completed = yield* withMeetingPublicationMutationGuard(
									executor.oauth.complete(
										{ state: started.state, code },
										{
											beforeCommit: authorize(freshGuard).pipe(
												Effect.mapError(
													() => new OAuthCompleteError({ message: "Reconnect authorization rejected." }),
												),
											),
										},
									),
									authorize(freshGuard),
								).pipe(Effect.mapError(() => new EngineMeetingReconnectError({ code: "consent_failed" })));
								if (
									completed.owner !== ref.owner ||
									completed.integration !== ref.integration ||
									completed.name !== ref.name ||
									completed.template !== connection.template
								)
									return yield* new EngineMeetingReconnectError({ code: "invalid_session" });
								yield* authorize(freshGuard);
								const result = yield* withMeetingPublicationMutationGuard(
									executor.execute(
										ToolAddress.make(
											`tools.${ref.integration}.${ref.owner}.${ref.name}.${GOOGLE_MEETING_PREFLIGHT_TOOL}`,
										),
										{
											expectedOwnerEmail,
										},
									),
									authorize(freshGuard),
								).pipe(
									Effect.mapError(() => new EngineMeetingReconnectError({ code: "provider_unavailable" })),
								);
								if (isRecord(result) && result.ok === true && result.data === true) return;
								return yield* new EngineMeetingReconnectError({
									code:
										isRecord(result) && isRecord(result.error) && result.error.code === "identity_mismatch"
											? "identity_mismatch"
											: "provider_unavailable",
								});
							}).pipe(
								Effect.ensuring(
									Effect.sync(() => {
										inFlight = false;
									}),
								),
							);
						}),
					cancel: (freshGuard) =>
						Effect.gen(function* () {
							if (inFlight || cancelled)
								return yield* new EngineMeetingReconnectError({ code: "invalid_session" });
							cancelled = true;
							yield* authorize(freshGuard);
							yield* withMeetingPublicationMutationGuard(
								executor.oauth.cancel(started.state),
								authorize(freshGuard),
							).pipe(Effect.mapError(() => new EngineMeetingReconnectError({ code: "provider_unavailable" })));
						}),
				} satisfies EngineMeetingReconnectSession);
			}),
		create: (input) =>
			executor.connections
				.create({
					owner: input.owner,
					integration: IntegrationSlug.make(input.integration),
					name: ConnectionName.make(input.name),
					template: AuthTemplateSlug.make(input.template),
					values: { ...input.values },
					...(input.identityLabel === undefined ? {} : { identityLabel: input.identityLabel }),
					...(input.description === undefined ? {} : { description: input.description }),
				})
				.pipe(
					Effect.map(
						(connection) =>
							new EngineConnection({
								owner: connection.owner,
								integration: String(connection.integration),
								name: String(connection.name),
							}),
					),
				),
		list: (filter) =>
			executor.connections
				.list({
					...(filter?.integration === undefined ? {} : { integration: IntegrationSlug.make(filter.integration) }),
					...(filter?.owner === undefined ? {} : { owner: filter.owner }),
				})
				.pipe(
					Effect.map((connections) =>
						connections.map(
							(connection) =>
								new EngineConnection({
									owner: connection.owner,
									integration: String(connection.integration),
									name: String(connection.name),
								}),
						),
					),
				),
		checkHealth: (ref) =>
			executor.connections
				.checkHealth({
					owner: ref.owner,
					integration: IntegrationSlug.make(ref.integration),
					name: ConnectionName.make(ref.name),
				})
				.pipe(Effect.map((health) => new EngineHealth(health))),
	},
	tools: {
		list: (filter) =>
			executor.tools
				.list({
					...(filter?.integration === undefined ? {} : { integration: IntegrationSlug.make(filter.integration) }),
					...(filter?.owner === undefined ? {} : { owner: filter.owner }),
					...(filter?.connection === undefined ? {} : { connection: ConnectionName.make(filter.connection) }),
				})
				.pipe(
					Effect.map((tools) =>
						tools.map(
							(tool) =>
								new EngineTool({
									address: String(tool.address),
									owner: tool.owner,
									integration: String(tool.integration),
									connection: String(tool.connection),
									name: String(tool.name),
									description: tool.description,
								}),
						),
					),
				),
	},
	integrations: {
		list: () =>
			executor.integrations.list().pipe(
				Effect.map((integrations) =>
					integrations.map(
						(integration) =>
							new EngineIntegration({
								slug: String(integration.slug),
								name: integration.name,
								description: integration.description,
								kind: integration.kind,
							}),
					),
				),
			),
	},
	policies: {
		resolve: (address) =>
			executor.policies
				.resolve(ToolAddress.make(address))
				.pipe(Effect.map((decision) => new EnginePolicyDecision(decision))),
	},
});
