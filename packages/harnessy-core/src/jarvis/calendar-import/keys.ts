import { createHmac } from "node:crypto";

/**
 * An error whose message is fixed text written in this module tree. The CLI
 * prints only these messages; any other error becomes a generic message, so a
 * parser or provider message cannot carry file or account content to a log.
 */
export class CalendarImportError extends Error {}

/** Keyed HMAC-SHA-256 with the local importer salt. */
export const keyed = (salt: Buffer, ...parts: readonly string[]) =>
	createHmac("sha256", salt).update(parts.join("\u0000")).digest("hex");

/** Opaque key for a gws account folder name. Folder names can be addresses, so they never leave memory. */
export const accountKey = (salt: Buffer, slug: string) => keyed(salt, "account", slug);
/** Opaque key for the primary calendar ID of an account. */
export const identityKey = (salt: Buffer, primaryId: string) => keyed(salt, "identity", primaryId.toLowerCase());
/** Opaque key for a Jarvis action ID. Marker values from events are stored only in this form. */
export const actionKey = (salt: Buffer, actionId: string) => keyed(salt, "action", actionId.toLowerCase());
/** Opaque key for a Jarvis task ID. */
export const taskKey = (salt: Buffer, taskId: string) => keyed(salt, "task", taskId.toLowerCase());

/** A short opaque label for reports. It identifies an account between runs without naming it. */
export const accountLabel = (key: string) => key.slice(0, 12);
