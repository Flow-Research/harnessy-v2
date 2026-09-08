import {
	type AnyPlugin,
	AuthTemplateSlug,
	ConnectionName,
	type Executor,
	IntegrationSlug,
	ToolAddress,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";

import {
	EngineConnection,
	EngineHealth,
	EngineIntegration,
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
