import {
	ConnectorAuthError,
	ConnectorAuthorizationError,
	ConnectorDataError,
	ConnectorNotFoundError,
	ConnectorRateLimitError,
	type ConnectorReadError,
	ConnectorTransportError,
	ConnectorUnsupportedCapabilityError,
	ConnectorValidationError,
	type KnowledgeCapability,
	KnowledgeCapabilityEvidence,
} from "@harnessy/core/connectors/knowledge";
import { Schema } from "effect";

export interface EngineErrorContext {
	readonly backend: string;
	readonly operation: string;
	readonly capability: KnowledgeCapability;
}

export type EngineExecuteErrorWire =
	| { readonly _tag: "ToolNotFoundError"; readonly address: string }
	| {
			readonly _tag: "ToolInvocationError";
			readonly address: string;
			readonly message: string;
			readonly cause?: unknown;
	  }
	| { readonly _tag: "ToolBlockedError"; readonly address: string; readonly pattern: string }
	| { readonly _tag: "PluginNotLoadedError"; readonly address: string; readonly pluginId: string }
	| { readonly _tag: "NoHandlerError"; readonly address: string; readonly pluginId: string }
	| {
			readonly _tag: "ConnectionNotFoundError";
			readonly owner: string;
			readonly integration: string;
			readonly name: string;
	  }
	| { readonly _tag: "CredentialProviderNotRegisteredError"; readonly provider: string }
	| {
			readonly _tag: "CredentialResolutionError";
			readonly owner: string;
			readonly integration: string;
			readonly name: string;
			readonly message: string;
	  }
	| { readonly _tag: "ElicitationDeclinedError"; readonly address: string; readonly action: "decline" | "cancel" }
	| { readonly _tag: "StorageError"; readonly message: string; readonly cause: unknown }
	| { readonly _tag: "UniqueViolationError"; readonly model?: string };

const connectorErrorFromCause = (cause: unknown): ConnectorReadError | undefined => {
	if (
		cause instanceof ConnectorTransportError ||
		cause instanceof ConnectorAuthError ||
		cause instanceof ConnectorAuthorizationError ||
		cause instanceof ConnectorValidationError ||
		cause instanceof ConnectorDataError ||
		cause instanceof ConnectorRateLimitError ||
		cause instanceof ConnectorNotFoundError ||
		cause instanceof ConnectorUnsupportedCapabilityError
	) {
		return cause;
	}
	return undefined;
};

const unsupported = (context: EngineErrorContext, message: string) =>
	new ConnectorUnsupportedCapabilityError({
		backend: context.backend,
		operation: context.operation,
		message,
		evidence: new KnowledgeCapabilityEvidence({
			capability: context.capability,
			readable: false,
			mutable: false,
			reason: message,
		}),
	});

const assertNever = (value: never): never => {
	throw new Error(`Unmapped engine execute error: ${String(value)}`);
};

/** Total mapping from Executor's execute failure set into Harnessy's semantic read errors. */
export const mapEngineExecuteErrorWire = (
	error: EngineExecuteErrorWire,
	context: EngineErrorContext,
): ConnectorReadError => {
	switch (error._tag) {
		case "ToolNotFoundError":
			return unsupported(context, `Engine tool is not available: ${error.address}`);
		case "PluginNotLoadedError":
			return unsupported(context, `Engine plugin ${error.pluginId} is not loaded.`);
		case "NoHandlerError":
			return unsupported(context, `Engine plugin ${error.pluginId} cannot invoke this tool.`);
		case "ToolBlockedError":
			return new ConnectorAuthorizationError({
				backend: context.backend,
				operation: context.operation,
				message: `Engine policy blocked the operation with pattern ${error.pattern}.`,
			});
		case "ElicitationDeclinedError":
			return new ConnectorAuthorizationError({
				backend: context.backend,
				operation: context.operation,
				message: `Engine approval was ${error.action === "cancel" ? "cancelled" : "declined"}.`,
			});
		case "ConnectionNotFoundError":
			return new ConnectorAuthError({
				backend: context.backend,
				operation: context.operation,
				message: `Engine connection ${error.integration}.${error.owner}.${error.name} was not found.`,
			});
		case "CredentialProviderNotRegisteredError":
			return new ConnectorAuthError({
				backend: context.backend,
				operation: context.operation,
				message: `Credential provider ${error.provider} is not registered.`,
			});
		case "CredentialResolutionError":
			return new ConnectorAuthError({
				backend: context.backend,
				operation: context.operation,
				message: error.message,
			});
		case "ToolInvocationError": {
			const connectorError = connectorErrorFromCause(error.cause);
			return (
				connectorError ??
				new ConnectorDataError({
					backend: context.backend,
					operation: context.operation,
					message: error.message,
					cause: error.cause,
				})
			);
		}
		case "StorageError":
			return new ConnectorDataError({
				backend: context.backend,
				operation: context.operation,
				message: error.message,
				cause: error.cause,
			});
		case "UniqueViolationError":
			return new ConnectorDataError({
				backend: context.backend,
				operation: context.operation,
				message: `Engine storage uniqueness violation${error.model === undefined ? "" : ` for ${error.model}`}.`,
			});
		default:
			return assertNever(error);
	}
};

// ---------------------------------------------------------------------------
// Unknown-boundary decoding. HarnessyEngineHandle erases the engine's error
// union to `unknown`; recover the wire shape with Schema instead of casts.
// ---------------------------------------------------------------------------

const WireVariant = <Tag extends string, Fields extends Schema.Struct.Fields>(tag: Tag, fields: Fields) =>
	Schema.Struct({ _tag: Schema.Literal(tag), ...fields });

const EngineExecuteErrorWireSchema = Schema.Union([
	WireVariant("ToolNotFoundError", { address: Schema.String }),
	WireVariant("ToolInvocationError", {
		address: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	}),
	WireVariant("ToolBlockedError", { address: Schema.String, pattern: Schema.String }),
	WireVariant("PluginNotLoadedError", { address: Schema.String, pluginId: Schema.String }),
	WireVariant("NoHandlerError", { address: Schema.String, pluginId: Schema.String }),
	WireVariant("ConnectionNotFoundError", {
		owner: Schema.String,
		integration: Schema.String,
		name: Schema.String,
	}),
	WireVariant("CredentialProviderNotRegisteredError", { provider: Schema.String }),
	WireVariant("CredentialResolutionError", {
		owner: Schema.String,
		integration: Schema.String,
		name: Schema.String,
		message: Schema.String,
	}),
	WireVariant("ElicitationDeclinedError", {
		address: Schema.String,
		action: Schema.Literals(["decline", "cancel"]),
	}),
	WireVariant("StorageError", { message: Schema.String, cause: Schema.Unknown }),
	WireVariant("UniqueViolationError", { model: Schema.optional(Schema.String) }),
]);

const decodeWire = Schema.decodeUnknownOption(EngineExecuteErrorWireSchema);

/**
 * Total mapping from an erased engine failure into the semantic read-error
 * algebra: pass a Connector error straight through (same-runtime plugin
 * failures arrive intact), decode known engine wire shapes, and classify
 * anything else as a data error carrying the original cause.
 */
export const mapUnknownEngineError = (error: unknown, context: EngineErrorContext): ConnectorReadError => {
	const passthrough = connectorErrorFromCause(error);
	if (passthrough !== undefined) return passthrough;
	const wire = decodeWire(error);
	if (wire._tag === "Some") {
		return mapEngineExecuteErrorWire(wire.value as EngineExecuteErrorWire, context);
	}
	return new ConnectorDataError({
		backend: context.backend,
		operation: context.operation,
		message: "Engine execution failed with an unrecognized error shape.",
		cause: error,
	});
};
