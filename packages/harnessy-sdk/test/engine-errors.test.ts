import { describe, expect, it } from "@effect/vitest";
import { ConnectorAuthError, ConnectorTransportError } from "@harnessy/core/connectors/knowledge";

import {
	type EngineErrorContext,
	type EngineExecuteErrorWire,
	mapEngineExecuteErrorWire,
	mapUnknownEngineError,
} from "../src/engine/errors.ts";

const context: EngineErrorContext = {
	backend: "anytype",
	operation: "spaces_list",
	capability: "spaces",
};

// One row per wire variant. If the engine grows a new failure and the union
// gains a member, this table stops compiling (variants is typed against the
// full union) and the mapping must be extended consciously.
const variants: ReadonlyArray<readonly [EngineExecuteErrorWire, string]> = [
	[{ _tag: "ToolNotFoundError", address: "a" }, "ConnectorUnsupportedCapabilityError"],
	[{ _tag: "ToolInvocationError", address: "a", message: "boom" }, "ConnectorDataError"],
	[{ _tag: "ToolBlockedError", address: "a", pattern: "*" }, "ConnectorAuthorizationError"],
	[{ _tag: "PluginNotLoadedError", address: "a", pluginId: "p" }, "ConnectorUnsupportedCapabilityError"],
	[{ _tag: "NoHandlerError", address: "a", pluginId: "p" }, "ConnectorUnsupportedCapabilityError"],
	[{ _tag: "ConnectionNotFoundError", owner: "org", integration: "anytype", name: "main" }, "ConnectorAuthError"],
	[{ _tag: "CredentialProviderNotRegisteredError", provider: "keychain" }, "ConnectorAuthError"],
	[
		{ _tag: "CredentialResolutionError", owner: "org", integration: "anytype", name: "main", message: "m" },
		"ConnectorAuthError",
	],
	[{ _tag: "ElicitationDeclinedError", address: "a", action: "decline" }, "ConnectorAuthorizationError"],
	[{ _tag: "StorageError", message: "m", cause: null }, "ConnectorDataError"],
	[{ _tag: "UniqueViolationError", model: "tool" }, "ConnectorDataError"],
];

describe("engine execute error mapping", () => {
	it("maps every wire variant into the semantic read-error algebra", () => {
		for (const [wire, expected] of variants) {
			expect(mapEngineExecuteErrorWire(wire, context)._tag).toBe(expected);
		}
	});

	it("passes same-runtime connector errors through unchanged", () => {
		const original = new ConnectorAuthError({
			backend: "anytype",
			operation: "spaces_list",
			message: "401",
		});
		expect(mapUnknownEngineError(original, context)).toBe(original);
		const wrapped = mapUnknownEngineError(
			{ _tag: "ToolInvocationError", address: "a", message: "wrapped", cause: original },
			context,
		);
		expect(wrapped).toBe(original);
	});

	it("decodes erased wire errors and classifies unknown shapes as data errors", () => {
		const decoded = mapUnknownEngineError({ _tag: "ToolBlockedError", address: "a", pattern: "anytype.*" }, context);
		expect(decoded._tag).toBe("ConnectorAuthorizationError");
		const unknown = mapUnknownEngineError(new Error("weird"), context);
		expect(unknown._tag).toBe("ConnectorDataError");
	});

	it("keeps transport errors typed end to end", () => {
		const transport = new ConnectorTransportError({
			backend: "anytype",
			operation: "spaces_list",
			message: "refused",
			retryable: true,
		});
		expect(mapUnknownEngineError(transport, context)).toBe(transport);
	});
});
