import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readStableMeetingPublicationSmokeFile } from "@harnessy/core/meeting-publication";

/** Explicit offline owner action. Never discovers keys or copies them into runtime state. */
export const signOwnerServiceRequest = (keyPath: string, fingerprint: string, signingBytes: Uint8Array): Buffer => {
	const uid = process.geteuid?.();
	if (uid === undefined) throw new Error("unsupported_platform");
	const file = readStableMeetingPublicationSmokeFile(keyPath, BigInt(uid), "private", 16384);
	try {
		const key = createPrivateKey(file.bytes);
		if (key.asymmetricKeyType !== "ed25519") throw new Error("invalid_key");
		const publicKey = createPublicKey(key).export({ type: "spki", format: "der" });
		if (createHash("sha256").update(publicKey).digest("hex") !== fingerprint) throw new Error("key_mismatch");
		return sign(null, signingBytes, key);
	} finally {
		file.bytes.fill(0);
	}
};
