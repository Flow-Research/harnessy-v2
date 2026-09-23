import { createHash, generateKeyPairSync } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runCommunityPublicationCommand } from "../src/community-publication-command.ts";

describe("community first-time authority setup", () => {
	it.each([
		"valid",
		"wrong-pin",
		"private-key",
		"public-key-mode",
		"state-mode",
		"existing-ledger",
		"existing-sidecar",
		"existing-control",
		"overlap",
		"extra-field",
	])("protects existing state: %s", async (scenario) => {
		const root = mkdtempSync(join(realpathSync(tmpdir()), "community-setup-"));
		chmodSync(root, 0o700);
		try {
			const state = join(root, "state"),
				control = join(root, "control");
			mkdirSync(state, { mode: 0o700 });
			mkdirSync(control, { mode: 0o700 });
			const keys = generateKeyPairSync("ed25519");
			const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
			const publicKeyPath = join(root, "owner-public.pem");
			writeFileSync(
				publicKeyPath,
				scenario === "private-key" ? keys.privateKey.export({ type: "pkcs8", format: "pem" }) : pem,
				{ mode: 0o600 },
			);
			const originalKey = readFileSync(publicKeyPath);
			const ledger = join(state, "community-grants.sqlite3");
			writeFileSync(join(state, "queue-sentinel"), "existing draft state", { mode: 0o600 });
			if (scenario === "public-key-mode") chmodSync(publicKeyPath, 0o644);
			if (scenario === "state-mode") chmodSync(state, 0o755);
			if (scenario === "existing-ledger") writeFileSync(ledger, "preserve revocations", { mode: 0o600 });
			if (scenario === "existing-sidecar") writeFileSync(`${ledger}-wal`, "unclean state", { mode: 0o600 });
			if (scenario === "existing-control")
				writeFileSync(join(control, "existing"), "preserve trust", { mode: 0o600 });
			const inputPath = join(root, "input.json");
			writeFileSync(
				inputPath,
				JSON.stringify({
					kind: "harnessy.community.briefing.service-setup.v1",
					stateDirectory: state,
					controlDirectory: scenario === "overlap" ? state : control,
					publicKeyPath,
					publicKeySha256:
						scenario === "wrong-pin"
							? "0".repeat(64)
							: createHash("sha256")
									.update(keys.publicKey.export({ type: "spki", format: "der" }))
									.digest("hex"),
					issuer: "fixture-owner",
					keyId: "existing-owner-key",
					...(scenario === "extra-field" ? { activate: true } : {}),
				}),
				{ mode: 0o600 },
			);
			const invoke = () =>
				Effect.runPromise(runCommunityPublicationCommand(["--setup-service", "--input", inputPath]));
			const result = await invoke();
			if (scenario === "valid") {
				expect(result.exitCode).toBe(0);
				expect(result.value).toMatchObject({
					kind: "harnessy.community.briefing.service-provisioned",
					activated: false,
				});
				const db = new DatabaseSync(ledger, { readOnly: true });
				try {
					expect(db.prepare("SELECT * FROM community_briefing_grants").all()).toEqual([]);
				} finally {
					db.close();
				}
				const trustPath = join(control, "community-trust.json");
				expect(JSON.parse(readFileSync(trustPath, "utf8"))).toMatchObject({
					keys: [{ issuer: "fixture-owner", keyId: "existing-owner-key", publicKeyPem: pem }],
				});
				for (const path of [ledger, trustPath]) expect(lstatSync(path).mode & 0o777).toBe(0o600);
				const before = readFileSync(ledger);
				expect((await invoke()).exitCode).toBe(1);
				expect(readFileSync(ledger)).toEqual(before);
			} else {
				expect(result).toEqual({
					exitCode: 1,
					stream: "stderr",
					value: { error: "community_publication_failed", code: "invalid_arguments" },
				});
				expect(readdirSync(control)).toEqual(scenario === "existing-control" ? ["existing"] : []);
				if (scenario === "existing-ledger") expect(readFileSync(ledger, "utf8")).toBe("preserve revocations");
				else expect(readdirSync(state)).not.toContain("community-grants.sqlite3");
			}
			expect(readFileSync(publicKeyPath)).toEqual(originalKey);
			expect(readFileSync(join(state, "queue-sentinel"), "utf8")).toBe("existing draft state");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
