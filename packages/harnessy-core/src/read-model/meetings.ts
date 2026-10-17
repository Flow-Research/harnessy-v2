/**
 * Read-only meeting publication summary: queue counts, items waiting for review
 * and provider health. The provider account is never returned.
 */
import type { JarvisMeetingPublicationConfig } from "../jarvis/config-model.ts";
import { inspectMeetingPublicationQueue } from "../jarvis/meeting-publication/inspector.ts";
import type { MeetingConfigData, MeetingProviderHealthData, MeetingQueueData } from "./schemas.ts";
import { okTile, type ReadModelOptions, readClock, readTimeout, stateTile, type TileResult } from "./tile.ts";

export interface MeetingReadOptions extends ReadModelOptions {
	/** Pending-review items to return (1–100, default 20). */
	readonly pendingLimit?: number;
}

export interface MeetingSummary {
	readonly config: TileResult<MeetingConfigData>;
	readonly queue: TileResult<MeetingQueueData>;
	readonly providers: TileResult<MeetingProviderHealthData>;
}

/** Meeting publication queue and provider health. Reads only; never opens the writer store. */
export const readMeetingSummary = (
	config: JarvisMeetingPublicationConfig,
	options: MeetingReadOptions = {},
): MeetingSummary => {
	const now = readClock(options);
	const configTile = okTile(
		{ enabled: config.enabled, reviewHost: config.reviewHost, reviewPort: config.reviewPort },
		now,
	);
	// The inspection reports every failure as a state; it does not throw.
	const inspection = inspectMeetingPublicationQueue(config, {
		timeoutMs: readTimeout(options),
		...(options.pendingLimit === undefined ? {} : { pendingLimit: options.pendingLimit }),
	});
	if (inspection.state !== "ok") {
		return {
			config: configTile,
			queue: stateTile(inspection.state, inspection.reason, now),
			providers: stateTile(inspection.state, inspection.reason, now),
		};
	}
	return {
		config: configTile,
		queue: okTile(
			{
				schemaVersion: inspection.schemaVersion,
				schemaState: inspection.schemaState,
				totalItems: inspection.totalItems,
				statusCounts: { ...inspection.statusCounts },
				failureCounts: { ...inspection.failureCounts },
				pendingReview: inspection.pendingReview.map((item) => ({ ...item })),
				pendingReviewTruncated: inspection.pendingReviewTruncated,
			},
			now,
		),
		providers:
			inspection.providerHealth === null
				? stateTile("unsupported", "schema_migration_required", now)
				: okTile({ providers: inspection.providerHealth.map((health) => ({ ...health })) }, now),
	};
};
