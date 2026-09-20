import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import { createCodexLifeDraftProvider } from "./codex-provider.ts";
import type { LifeOrchestratorSettings } from "./config.ts";
import { LifeDraftGrantHost } from "./draft-grant-host.ts";
import { generateLifeDraft, LifeDraftAuthority, type LifeDraftProvider, LifeDraftRequest } from "./draft-provider.ts";

const SignedGrant = Schema.Struct({ issuer: Schema.String, authority: LifeDraftAuthority, signature: Schema.String });

export interface NativeLifePreviewOptions {
	readonly requestPath: string;
	readonly grantPath: string;
	readonly trustedPublicKeyPath: string;
}

/** Read bounded private inputs without following a final-component symlink. */
export const readPrivateLifeInput = (path: string, maximumBytes: number): string => {
	if (!process.getuid || process.platform === "win32")
		throw new Error("Native Life preview requires POSIX ownership.");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.uid !== process.getuid() ||
			(stat.mode & 0o077) !== 0 ||
			stat.size > maximumBytes
		)
			throw new Error("Life input must be a bounded owner-only regular file.");
		const text = readFileSync(fd, "utf8");
		if (Buffer.byteLength(text) > maximumBytes) throw new Error("Life input grew beyond its bound.");
		return text;
	} finally {
		closeSync(fd);
	}
};

export const readNativeLifeRequest = (
	options: NativeLifePreviewOptions,
	date: string,
	kind: "daily" | "weekly" = "daily",
): LifeDraftRequest => {
	const request = Schema.decodeUnknownSync(LifeDraftRequest)(
		JSON.parse(readPrivateLifeInput(options.requestPath, 2 * 1024 * 1024)),
	);
	if (
		request.kind !== kind ||
		request.provider !== "codex" ||
		!request.runId.startsWith(`${kind}:${date}:`) ||
		Buffer.byteLength(request.prompt) > 262144
	)
		throw new Error(
			"Native Life request must match the current planning period, kind, Codex provider and prompt bound.",
		);
	return request;
};

/** One real signed authorization boundary; injected providers are for isolated host tests. */
export const generateNativeLifePreview = async (
	settings: LifeOrchestratorSettings,
	options: NativeLifePreviewOptions,
	request: LifeDraftRequest,
	signal: AbortSignal,
	provider?: LifeDraftProvider,
) => {
	const signed = Schema.decodeUnknownSync(SignedGrant)(JSON.parse(readPrivateLifeInput(options.grantPath, 16384)));
	const publicKey = readPrivateLifeInput(options.trustedPublicKeyPath, 16384);
	const host = new LifeDraftGrantHost(settings.paths.stateDirectory, new Map([[signed.issuer, publicKey]]));
	try {
		const selected =
			provider ??
			({
				// Recompute the remaining signed lifetime only after authorize has
				// durably consumed the grant, immediately before credential loading.
				generate: (input, activeSignal) =>
					createCodexLifeDraftProvider({
						authPath: join(process.env.HSY_CODING_AGENT_DIR ?? join(homedir(), ".hsy", "agent"), "auth.json"),
						timeoutMs: Math.max(1, Math.min(600000, Date.parse(signed.authority.expiresAt) - Date.now())),
						maximumOutputBytes: signed.authority.maximumOutputBytes,
					}).generate(input, activeSignal),
			} satisfies LifeDraftProvider);
		return await generateLifeDraft(request, signed.authority, { ...host.bind(signed), provider: selected, signal });
	} finally {
		host.close();
	}
};

/** One exclusive, fsynced review record binds final bytes, not merely the provider's raw output. */
export const saveNativeLifeReview = (
	path: string,
	markdown: string,
	receipt: Awaited<ReturnType<typeof generateNativeLifePreview>>["receipt"],
): void => {
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				status: "needs_review",
				markdown,
				receipt,
				artifactHash: createHash("sha256").update(markdown).digest("hex"),
			},
			null,
			2,
		)}\n`,
		{ encoding: "utf8", flag: "wx", mode: 0o600, flush: true },
	);
};
