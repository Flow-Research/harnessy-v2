import { createHash } from "node:crypto";
import { newPortalSecret } from "./token-store.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** The native app receives only an approval ID; only the initiating tab can claim the grant. */
export class BrowserSignIn {
	readonly pending = new Map<string, { claimHash: string; expiresAt: number; approved: boolean }>();
	readonly clock: () => number;
	constructor(clock: () => number) {
		this.clock = clock;
	}
	begin() {
		for (const [id, item] of this.pending) if (item.expiresAt <= this.clock()) this.pending.delete(id);
		if (this.pending.size >= 16) return undefined;
		const id = newPortalSecret();
		const claim = newPortalSecret();
		this.pending.set(id, { claimHash: hash(claim), expiresAt: this.clock() + 60000, approved: false });
		return { id, claim };
	}
	approve(id: string) {
		const item = this.pending.get(id);
		if (!item || item.expiresAt <= this.clock() || item.approved) return false;
		item.approved = true;
		return true;
	}
	claim(id: string, secret: string): "invalid" | "pending" | "approved" {
		const item = this.pending.get(id);
		if (!item || item.expiresAt <= this.clock() || item.claimHash !== hash(secret)) return "invalid";
		if (!item.approved) return "pending";
		this.pending.delete(id);
		return "approved";
	}
}
