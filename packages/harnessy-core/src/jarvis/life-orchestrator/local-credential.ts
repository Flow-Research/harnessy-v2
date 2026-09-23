import { refreshOpenAICodexToken } from "@earendil-works/pi-ai/oauth";
import { FileAuthStorageBackend } from "@earendil-works/pi-coding-agent/auth-storage";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import { readStableMeetingPublicationSmokeFile } from "../meeting-publication/operational-input.ts";

const Credential = Schema.Struct({
	type: Schema.Literal("oauth"),
	access: Schema.String,
	refresh: Schema.optional(Schema.String),
	expires: Schema.Number,
	accountId: Schema.String,
});
const decode = (raw: string) => {
	const document: unknown = JSON.parse(raw);
	if (typeof document !== "object" || document === null || Array.isArray(document) || !("openai-codex" in document))
		throw new Error("Missing saved Codex OAuth credential.");
	const credential = Schema.decodeUnknownSync(Credential)(document["openai-codex"]);
	const parts = credential.access.split(".");
	if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part)))
		throw new Error("Invalid access token.");
	const claims = Schema.decodeUnknownSync(
		Schema.Struct({
			exp: Schema.Number,
			"https://api.openai.com/auth": Schema.Struct({ chatgpt_account_id: Schema.String }),
		}),
	)(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
	if (
		!credential.accountId.trim() ||
		credential.accountId !== claims["https://api.openai.com/auth"].chatgpt_account_id ||
		!Number.isFinite(credential.expires) ||
		!Number.isFinite(claims.exp)
	)
		throw new Error("Invalid OAuth account or expiry.");
	return { document, credential, expires: Math.min(credential.expires, claims.exp * 1000) };
};

/** Reuse the installed login's lock, never another account, API key or token cache.
 * The caller must consume its run first and check cancellation again before generation.
 */
export const refreshLocalLifeCredential = async (
	authPath: string,
	signal: AbortSignal,
	refresh = refreshOpenAICodexToken,
): Promise<void> =>
	Effect.runPromise(
		Effect.tryPromise({
			try: async () => {
				signal.throwIfAborted();
				if (!process.getuid || process.platform === "win32") throw new Error("POSIX ownership required.");
				const uid = BigInt(process.getuid());
				const read = () =>
					readStableMeetingPublicationSmokeFile(authPath, uid, "private", 65536).bytes.toString("utf8");
				const initial = decode(read());
				if (initial.expires > Date.now()) return;
				const backend = new FileAuthStorageBackend(authPath);
				await backend.withLockAsync(async (current) => {
					signal.throwIfAborted();
					if (current === undefined || current !== read()) throw new Error("Credential changed while locking.");
					const saved = decode(current);
					if (saved.credential.accountId !== initial.credential.accountId)
						throw new Error("Account changed while locking.");
					if (saved.expires > Date.now()) return { result: undefined };
					if (!saved.credential.refresh?.trim()) throw new Error("Interactive login required.");
					const refreshed = await refresh(saved.credential.refresh, signal);
					const next = JSON.stringify(
						{ ...saved.document, "openai-codex": { ...refreshed, type: "oauth" } },
						null,
						2,
					);
					const checked = decode(next);
					if (
						checked.credential.accountId !== initial.credential.accountId ||
						checked.expires <= Date.now() ||
						!checked.credential.refresh?.trim() ||
						Buffer.byteLength(next) > 65536 ||
						current !== read()
					)
						throw new Error("Refreshed credential does not match the saved account.");
					// Preserve a successful token rotation even if the caller just cancelled;
					// cancellation still prevents generation, not safe credential persistence.
					return { result: undefined, next };
				}, signal);
				signal.throwIfAborted();
			},
			catch: () =>
				new Error(
					"V2 Codex login could not be renewed safely; no draft was generated. Check the saved login before retrying.",
				),
		}),
	);
