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
import { afterEach, beforeEach, expect, it } from "vitest";
import { canonicalMeetingPublicationSmokeJson } from "../src/jarvis/meeting-publication/operational-input.ts";
import { provisionMeetingPublicationService } from "../src/jarvis/meeting-publication/service-setup.ts";
import { validateMeetingPublicationStoreSchema } from "../src/jarvis/meeting-publication/store-schema.ts";

let root: string;
let input: Record<string, unknown>;
beforeEach(() => {
	root = mkdtempSync(join(realpathSync(tmpdir()), "service-first-install-"));
	for (const name of ["state", "control"]) mkdirSync(join(root, name), { mode: 0o700 });
	const { publicKey } = generateKeyPairSync("ed25519");
	writeFileSync(join(root, "owner.pub"), publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
	input = {
		kind: "harnessy.meeting-publication.service-setup.v1",
		stateDirectory: join(root, "state"),
		controlDirectory: join(root, "control"),
		publicKeyPath: join(root, "owner.pub"),
		publicKeySha256: createHash("sha256")
			.update(publicKey.export({ type: "spki", format: "der" }))
			.digest("hex"),
		issuer: "fixture-owner",
		keyId: "existing-key",
	};
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("creates only an empty queue and pinned service trust using the existing public key", () => {
	const before = readFileSync(join(root, "owner.pub"));
	const result = provisionMeetingPublicationService(input);
	expect(result.activated).toBe(false);
	expect(readFileSync(join(root, "owner.pub"))).toEqual(before);
	const trustBytes = readFileSync(result.trustedKeyring.path);
	expect(createHash("sha256").update(trustBytes).digest("hex")).toBe(result.trustedKeyring.sha256);
	const trust = JSON.parse(trustBytes.toString());
	expect(trust.keys).toEqual([
		{
			issuer: input.issuer,
			keyId: input.keyId,
			publicKeyPem: before.toString(),
			publicKeySha256: input.publicKeySha256,
		},
	]);
	for (const path of [join(root, "state/meeting-publication.sqlite3"), trust.replay.path]) {
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			if (path === trust.replay.path) {
				expect(db.prepare("SELECT instance_id FROM runtime_metadata").get()?.instance_id).toBe(
					trust.replay.instanceId,
				);
				for (const table of ["consumed_authorizations", "active_lease", "revocations"])
					expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count).toBe(0);
			} else {
				expect(validateMeetingPublicationStoreSchema(db).version).toBe(4);
				expect(db.prepare("SELECT COUNT(*) AS count FROM publication_items").get()?.count).toBe(0);
			}
		} finally {
			db.close();
		}
	}
	expect(() => provisionMeetingPublicationService(input)).toThrow();
	expect(readFileSync(result.trustedKeyring.path)).toEqual(trustBytes);
});

it.each(["state exists", "control exists", "public directory", "overlap", "wrong key", "private key", "extra input"])(
	"rejects %s before provisioning",
	(failure) => {
		if (failure === "state exists") writeFileSync(join(root, "state/receipt"), "preserved");
		if (failure === "control exists") writeFileSync(join(root, "control/lease"), "preserved");
		if (failure === "public directory") chmodSync(join(root, "state"), 0o755);
		if (failure === "overlap") input.controlDirectory = input.stateDirectory;
		if (failure === "wrong key") input.publicKeySha256 = "0".repeat(64);
		if (failure === "private key")
			writeFileSync(
				join(root, "owner.pub"),
				generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
			);
		if (failure === "extra input") input.secret = "CANARY";
		const before = ["state", "control"].map((name) => readdirSync(join(root, name)));
		expect(() => provisionMeetingPublicationService(input)).toThrow();
		expect(["state", "control"].map((name) => readdirSync(join(root, name)))).toEqual(before);
	},
);

it.each([
	"valid",
	"remounted replay",
	"remounted stale hash",
	"wrong pin",
	"wrong instance",
	"active lease",
	"revoked key",
	"nonempty output",
	"unsafe output",
])("adopts existing finite trust without resetting state: %s", (failure) => {
	const initial = provisionMeetingPublicationService(input);
	const trust = JSON.parse(readFileSync(initial.trustedKeyring.path, "utf8"));
	const currentReplay = { ...trust.replay };
	if (failure !== "remounted replay" && failure !== "remounted stale hash") {
		trust.kind = "harnessy.meeting-publication.full-review-trust";
		trust.audience = "harnessy.meeting-publication.full-review.v1";
	}
	if (failure === "remounted replay" || failure === "remounted stale hash")
		trust.replay.device = String(BigInt(trust.replay.device) + 1n);
	const finitePath = join(root, "finite-trust.json");
	const finiteBytes = `${canonicalMeetingPublicationSmokeJson(trust)}\n`;
	writeFileSync(finitePath, finiteBytes, { mode: 0o600 });
	const db = new DatabaseSync(trust.replay.path);
	try {
		db.prepare("INSERT INTO consumed_authorizations VALUES (?,?,?,?,?,?)").run(
			"old-session",
			"old-nonce",
			"a".repeat(64),
			"existing-key",
			"2026-01-01T00:00:00.000Z",
			"drained",
		);
		db.exec("UPDATE runtime_metadata SET revocation_sequence=1");
		db.prepare("INSERT INTO revocations VALUES (1,?,?,?)").run(
			failure === "revoked key" ? "key" : "authorization",
			failure === "revoked key" ? "existing-key" : "old-session",
			"2026-01-01T00:00:00.000Z",
		);
		if (failure === "wrong instance") db.prepare("UPDATE runtime_metadata SET instance_id=?").run("b".repeat(64));
		if (failure === "active lease")
			db.exec(
				"INSERT INTO active_lease VALUES (1,'lease','old-session','old-nonce','digest','existing-key','501',1,'boot','expired',0,'0',1)",
			);
	} finally {
		db.close();
	}
	const control = join(root, "adoption");
	mkdirSync(control, { mode: failure === "unsafe output" ? 0o755 : 0o700 });
	if (failure === "nonempty output") writeFileSync(join(control, "owner-file"), "keep");
	const stat = lstatSync(finitePath, { bigint: true });
	const remount = failure === "remounted replay" || failure === "remounted stale hash";
	const adoption = {
		kind: remount
			? ("harnessy.meeting-publication.service-remount-adoption.v2" as const)
			: ("harnessy.meeting-publication.service-adoption.v1" as const),
		controlDirectory: control,
		trustedKeyring: {
			path: finitePath,
			device: stat.dev.toString(),
			inode: stat.ino.toString(),
			sha256: failure === "wrong pin" ? "0".repeat(64) : createHash("sha256").update(finiteBytes).digest("hex"),
		},
		...(remount
			? {
					replaySha256:
						failure === "remounted stale hash"
							? "0".repeat(64)
							: createHash("sha256").update(readFileSync(trust.replay.path)).digest("hex"),
					expectedRevocationSequence: 1,
				}
			: {}),
	};
	const paths = [
		finitePath,
		initial.trustedKeyring.path,
		trust.replay.path,
		join(root, "state/meeting-publication.sqlite3"),
	];
	const before = paths.map((path) => readFileSync(path));
	const outputBefore = readdirSync(control);
	if (failure === "valid" || failure === "remounted replay") {
		const result = provisionMeetingPublicationService(adoption);
		expect(result.activated).toBe(false);
		const adopted = JSON.parse(readFileSync(result.trustedKeyring.path, "utf8"));
		expect(adopted).toEqual({
			...trust,
			kind: "harnessy.meeting-publication.service-trust",
			audience: "harnessy.meeting-publication.service.v1",
			replay: currentReplay,
		});
		expect(readdirSync(control)).toEqual(["service-trust.json"]);
		expect(() => provisionMeetingPublicationService(adoption)).toThrow();
	} else {
		expect(() => provisionMeetingPublicationService(adoption)).toThrow();
		expect(readdirSync(control)).toEqual(outputBefore);
	}
	expect(paths.map((path) => readFileSync(path))).toEqual(before);
});
