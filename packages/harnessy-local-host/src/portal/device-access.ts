import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Device {
	id: string;
	hash: string;
	expiresAt: number;
	name: string;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const DAY = 86400000;

/** One-time desktop-authorised enrollment. Durable device secrets are stored only as hashes. */
export class DeviceAccess {
	readonly origin: string;
	readonly file: string;
	readonly clock: () => number;
	private devices: Device[];
	private codes = new Map<string, { name: string; expiresAt: number }>();
	constructor(root: string, origin: string, clock = Date.now) {
		const parsed = new URL(origin);
		if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password)
			throw new Error("invalid_remote_origin");
		this.origin = origin;
		this.file = join(root, "devices.json");
		this.clock = clock;
		this.devices = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Device[]) : [];
	}
	private save() {
		writeFileSync(`${this.file}.tmp`, JSON.stringify(this.devices), { mode: 0o600 });
		renameSync(`${this.file}.tmp`, this.file);
	}
	list() {
		return this.devices
			.filter((d) => d.expiresAt > this.clock())
			.map(({ id, name, expiresAt }) => ({ id, name, expiresAt }));
	}
	pair(name: string) {
		if (!name.trim() || name.length > 80) throw new Error("invalid_device_name");
		this.codes.clear();
		const code = secret();
		const expiresAt = this.clock() + 60000;
		this.codes.set(digest(code), { name, expiresAt });
		return { url: `${this.origin}/#pair=${code}`, expiresAt };
	}
	exchange(code: string) {
		const key = digest(code);
		const pending = this.codes.get(key);
		this.codes.delete(key);
		if (!pending || pending.expiresAt <= this.clock()) return undefined;
		const token = secret();
		this.devices.push({
			id: randomUUID(),
			name: pending.name,
			hash: digest(token),
			expiresAt: this.clock() + 30 * DAY,
		});
		this.save();
		return token;
	}
	identify(cookie: string | undefined) {
		const value = /(?:^|;\s*)__Host-harnessy_device=([A-Za-z0-9_-]{43})(?:;|$)/u.exec(cookie ?? "")?.[1];
		return value ? this.devices.find((d) => d.hash === digest(value) && d.expiresAt > this.clock())?.id : undefined;
	}
	revoke(id: string) {
		this.devices = this.devices.filter((d) => d.id !== id);
		this.save();
	}
	cookie(token: string) {
		return `__Host-harnessy_device=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${(30 * DAY) / 1000}`;
	}
}
