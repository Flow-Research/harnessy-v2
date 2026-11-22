import * as Result from "effect/Result";
import type { RemoteAuthorityReceipt } from "./controller.ts";
import type { HostEnrollment, HostLaunch } from "./host-contract.ts";
import type { EngineeringInterventionStore } from "./host-intervention.ts";
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
	readonly #enrollment: HostEnrollment;
	readonly #interventions: EngineeringInterventionStore | undefined;

	/** Without an intervention ledger, every received answer is refused. */
	constructor(
		store: EngineeringStore,
		enrollment: HostEnrollment,
		transport: GardenHostTransport,
		now: () => number = Date.now,
		interventions?: EngineeringInterventionStore,
	) {
		this.#store = store;
		this.#transport = transport;
		this.#now = now;
		this.#enrollment = enrollment;
		this.#interventions = interventions;
		store.configureHostDelivery(enrollment, transport.endpoint, now());
	}

	async poll(): Promise<HostDeliveryResult> {
		const transport = await this.#transport.send({ operation: "pull", afterSequence: 0 });
		if (transport.status !== "received")
			return { status: "paused", reason: "Host pull was not confirmed", transport };
		if (transport.outcome.kind !== "commands")
			return { status: "paused", reason: "Host pull returned another operation", transport };
		const commands = transport.outcome.commands;
		const recorded = Result.try(() => {
			for (const entry of commands) {
				if (entry.kind === "launch") this.#store.acceptHostLaunch(entry.launch, this.#now());
				else if (entry.kind === "cancel") this.#store.acceptHostCancellation(entry.command, this.#now());
			}
		});
		if (Result.isFailure(recorded))
			return {
				status: "paused",
				reason: "Remote command could not be reconciled with the private ledger",
				transport,
			};
		// Answers follow launches and cancellations, so that a refused answer cannot hold back a cancellation.
		const interventions = this.#interventions;
		let refused = 0;
		for (const entry of commands)
			if (
				entry.kind === "answer" &&
				(interventions === undefined ||
					Result.isFailure(
						Result.try(() => interventions.acceptAnswer(entry.answer, this.#enrollment.operatorId, this.#now())),
					))
			)
				refused++;
		return refused > 0
			? { status: "paused", reason: `${refused} intervention answer(s) refused; no effect applied`, transport }
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
