import { Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisLegacyConfigOverride } from "./config-model.ts";

export class JarvisEnvironment extends Context.Service<
	JarvisEnvironment,
	{
		readonly entries: Effect.Effect<ReadonlyArray<readonly [string, string]>>;
	}
>()("@harnessy/core/JarvisEnvironment") {
	static readonly liveLayer = Layer.succeed(
		JarvisEnvironment,
		JarvisEnvironment.of({
			entries: Effect.sync(() =>
				Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
			),
		}),
	);

	static testLayer(entries: Readonly<Record<string, string>>) {
		return Layer.succeed(
			JarvisEnvironment,
			JarvisEnvironment.of({ entries: Effect.succeed(Object.entries(entries)) }),
		);
	}
}

interface EnvNode {
	value?: unknown;
	readonly children: Map<string, EnvNode>;
}

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

const complexTopLevelFields = new Set([
	"backends",
	"content",
	"analytics",
	"fathom",
	"whatsapp",
	"meeting_publication",
]);

const decodeEnvironmentValue = (value: string, requireJson: boolean) => {
	const decoded = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(value);
	return requireJson ? decoded : decoded.pipe(Effect.catch(() => Effect.succeed(value)));
};

const envNodeValue = (node: EnvNode): Effect.Effect<unknown, Schema.SchemaError> =>
	Effect.gen(function* () {
		if (node.children.size === 0) return node.value ?? {};
		const base =
			node.value === undefined
				? ({} as Record<string, unknown>)
				: yield* Schema.decodeUnknownEffect(UnknownRecord)(node.value);
		const nested: Record<string, unknown> = {};
		for (const [key, child] of node.children) {
			nested[key] = yield* envNodeValue(
				child.value === undefined ? { value: base[key], children: child.children } : child,
			);
		}
		return { ...base, ...nested };
	});

/** Decodes Pydantic-style, case-insensitive JARVIS_ variables and nested __ overrides. */
export const decodeJarvisEnvironment = Effect.fn("JarvisEnvironment.decode")(function* (
	entries: ReadonlyArray<readonly [string, string]>,
) {
	const root: EnvNode = { children: new Map() };
	for (const [name, value] of entries) {
		const normalized = name.toUpperCase();
		if (!normalized.startsWith("JARVIS_")) continue;
		const path = normalized
			.slice("JARVIS_".length)
			.split("__")
			.map((segment) => segment.toLowerCase())
			.filter(Boolean);
		if (path.length === 0) continue;
		let node = root;
		for (const segment of path) {
			const child = node.children.get(segment) ?? { children: new Map<string, EnvNode>() };
			node.children.set(segment, child);
			node = child;
		}
		node.value = yield* decodeEnvironmentValue(value, path.length === 1 && complexTopLevelFields.has(path[0]));
	}
	return yield* Schema.decodeUnknownEffect(JarvisLegacyConfigOverride)(yield* envNodeValue(root));
});
