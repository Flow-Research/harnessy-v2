import * as Result from "effect/Result";
import type { RemoteAuthorityReceipt } from "./controller.ts";
import type { HostEnrollment, HostLaunch } from "./host-contract.ts";
import type { GardenHostTransport, GardenHostTransportResult } from "./host-transport.ts";
import type { EngineeringStore } from "./store.ts";

export interface HostDeliveryResult {
	readonly status: "received" | "confirmed" | "idle" | "paused";
	readonly reason: string;
	readonly transport?: GardenHostTransportResult;
}

/** One broker call performs one network attempt. The existing controller owns scheduling and execution. */
export class EngineeringHostDelivery {
	readonly #store: EngineeringStore;
	readonly #transport: GardenHostTransport;
	readonly #now: () => number;

	constructor(
		store: EngineeringStore,
		enrollment: HostEnrollment,
		transport: GardenHostTransport,
		now: () => number = Date.now,
	) {
		this.#store = store;
		this.#transport = transport;
		this.#now = now;
		store.configureHostDelivery(enrollment, transport.endpoint, now());
	}

	async poll(): Promise<HostDeliveryResult> {
		const transport = await this.#transport.send({ operation: "pull", afterSequence: 0 });
		if (transport.status !== "received")
			return { status: "paused", reason: "Host pull was not confirmed", transport };
		if (transport.outcome.kind !== "commands")
			return { status: "paused", reason: "Host pull returned another operation", transport };
		const recorded = Result.try(() => {
			for (const entry of transport.outcome.kind === "commands" ? transport.outcome.commands : []) {
				if (entry.kind === "launch") this.#store.acceptHostLaunch(entry.launch, this.#now());
				else this.#store.acceptHostCancellation(entry.command, this.#now());
			}
		});
		return Result.isFailure(recorded)
			? { status: "paused", reason: "Remote command could not be reconciled with the private ledger", transport }
			: { status: "received", reason: "Remote commands retained; no worker was started", transport };
	}

	async flushOne(): Promise<HostDeliveryResult> {
		const pending = this.#store.pendingHostOperation();
		if (pending === undefined) return { status: "idle", reason: "No pending host operation" };
		const transport = await this.#transport.send(pending.body);
		if (transport.status !== "received")
			return { status: "paused", reason: "Host operation remains pending; delivery is not confirmed", transport };
		const recorded = Result.try(() => this.#store.confirmHostOperation(pending, transport.outcome, this.#now()));
		return Result.isFailure(recorded)
			? { status: "paused", reason: "Host receipt differs from the durable operation", transport }
			: { status: "confirmed", reason: "Exact host receipt retained; execution authority is separate", transport };
	}

	async authority(launch: HostLaunch): Promise<RemoteAuthorityReceipt> {
		const retained = this.#store.hostOffer(launch.launchId);
		if (
			retained === undefined ||
			retained.disposition !== "offered" ||
			JSON.stringify(retained.launch) !== JSON.stringify(launch)
		)
			return { status: "refused", reason: "Remote launch differs from private ledger" };
		const transport = await this.#transport.send({
			operation: "authority",
			launchId: launch.launchId,
			grantId: launch.grant.id,
		});
		if (transport.status !== "received")
			return { status: "unavailable", reason: "Live remote authority could not be verified" };
		if (transport.outcome.kind !== "authority_current")
			return { status: "refused", reason: "Remote authority refused" };
		return {
			status: "current",
			launchId: transport.outcome.launchId,
			grantId: transport.outcome.grantId,
			requestDigest: retained.launch.requestDigest,
			observedAt: this.#now(),
			expiresAt: Math.min(transport.outcome.expiresAt, retained.launch.grant.expiresAt),
		};
	}
}
