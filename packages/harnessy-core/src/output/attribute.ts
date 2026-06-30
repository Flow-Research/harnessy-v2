import type { AttributeBackfillResult, AttributeComputeResult, ComponentIndex } from "../skills/attribute.ts";
import type {
	AttributePacketResult,
	AttributeReviewQueue,
	AttributeReviewResult,
	ValidationSummary,
} from "../skills/attribute-validate.ts";

import { renderStructuredJson } from "./json.ts";

/** Render the stable structured JSON text for `harnessy skill attribute compute <skill> --json`. */
export const renderAttributeComputeJson = (result: AttributeComputeResult): string =>
	renderStructuredJson({
		command: "attribute-compute",
		ok: true,
		attributionId: result.attributionId,
		improvementId: result.improvementId,
		attributionsFile: result.attributionsFile,
		componentIndexFile: result.componentIndexFile,
		status: result.status,
		componentCount: result.componentCount,
		attribution: result.attribution,
		componentIndex: result.componentIndex,
	});

/** Render the stable structured JSON text for `harnessy skill attribute backfill <skill> --json`. */
export const renderAttributeBackfillJson = (result: AttributeBackfillResult): string =>
	renderStructuredJson({
		command: "attribute-backfill",
		ok: true,
		created: result.created,
		createdRecords: result.createdRecords,
		skippedExisting: result.skippedExisting,
		componentIndexFile: result.componentIndexFile,
		componentCount: result.componentCount,
		...(result.reason === undefined ? {} : { reason: result.reason }),
	});

/** Render the stable structured JSON text for `harnessy skill attribute index <skill> --json`. */
export const renderComponentIndexJson = (index: ComponentIndex): string =>
	renderStructuredJson({ command: "attribute-index", ok: true, ...index });

/** Render the stable structured JSON text for `harnessy skill attribute-validate queue <skill> --json`. */
export const renderAttributeReviewQueueJson = (queue: AttributeReviewQueue): string =>
	renderStructuredJson({
		command: "attribute-validate-queue",
		ok: true,
		skill: queue.skill,
		pendingReviewCount: queue.pendingReviewCount,
		pendingReviews: queue.pendingReviews,
	});

/** Render the stable structured JSON text for `harnessy skill attribute-validate review <skill> --json`. */
export const renderAttributeReviewJson = (result: AttributeReviewResult): string =>
	renderStructuredJson({
		command: "attribute-validate-review",
		ok: true,
		review: result.review,
		averageScore: result.averageScore,
	});

/** Render the stable structured JSON text for `harnessy skill attribute-validate packet <skill> --json`. */
export const renderAttributePacketJson = (result: AttributePacketResult): string =>
	renderStructuredJson({
		command: "attribute-validate-packet",
		ok: true,
		skill: result.skill,
		pendingReviewCount: result.pendingReviewCount,
		packetFile: result.packetFile,
	});

/** Render the stable structured JSON text for `harnessy skill attribute-validate summary <skill> --json`. */
export const renderValidationSummaryJson = (summary: ValidationSummary): string =>
	renderStructuredJson({ command: "attribute-validate-summary", ok: true, ...summary });
