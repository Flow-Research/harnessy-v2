import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface CalendarBlock {
	readonly block_id: string;
	readonly task_id: string;
	readonly task_title: string;
	readonly start: string;
	readonly end: string;
	readonly estimated_minutes: number;
	readonly reason: string;
}

export interface CalendarPlan {
	readonly version: 1;
	readonly plan_id: string;
	readonly backend: string;
	readonly space_id: string;
	readonly blocks: ReadonlyArray<CalendarBlock>;
}

const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 10_000 && !value.includes("\0");
const instant = (value: unknown): value is string =>
	text(value) && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

/** Read-only V2 consumer of the existing saved-plan format; never authorizes delivery. */
export const inspectCalendarPlan = (inputPath: string) => {
	const path = resolve(inputPath);
	if (realpathSync(path) !== path) throw new Error("Calendar plan must have a canonical, non-symlink path");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let bytes: Buffer;
	try {
		const before = fstatSync(fd, { bigint: true });
		if (
			!before.isFile() ||
			before.nlink !== 1n ||
			before.size > 1_048_576n ||
			(before.mode & 0o022n) !== 0n ||
			(process.geteuid !== undefined && before.uid !== BigInt(process.geteuid()))
		)
			throw new Error("Unsafe calendar plan file");
		bytes = readFileSync(fd);
		const after = fstatSync(fd, { bigint: true });
		if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
			throw new Error("Calendar plan changed while reading");
	} finally {
		closeSync(fd);
	}
	const value: unknown = JSON.parse(bytes.toString("utf8"));
	if (
		!object(value) ||
		value.version !== 1 ||
		!text(value.plan_id) ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(value.plan_id) ||
		!text(value.backend) ||
		!text(value.space_id) ||
		basename(path) !== `${value.plan_id}.json` ||
		!Array.isArray(value.blocks) ||
		value.blocks.length > 1000
	)
		throw new Error("Invalid saved calendar plan");
	const blocks: Array<CalendarBlock> = [];
	const ids = new Set<string>();
	for (const block of value.blocks) {
		if (
			!object(block) ||
			!text(block.block_id) ||
			ids.has(block.block_id) ||
			!text(block.task_id) ||
			!text(block.task_title) ||
			!instant(block.start) ||
			!instant(block.end) ||
			Date.parse(block.start) >= Date.parse(block.end) ||
			!Number.isSafeInteger(block.estimated_minutes) ||
			typeof block.estimated_minutes !== "number" ||
			block.estimated_minutes < 1 ||
			block.estimated_minutes > 1440 ||
			!text(block.reason)
		)
			throw new Error("Invalid calendar block");
		ids.add(block.block_id);
		blocks.push({
			block_id: block.block_id,
			task_id: block.task_id,
			task_title: block.task_title,
			start: block.start,
			end: block.end,
			estimated_minutes: block.estimated_minutes,
			reason: block.reason,
		});
	}
	const plan: CalendarPlan = {
		version: 1,
		plan_id: value.plan_id,
		backend: value.backend,
		space_id: value.space_id,
		blocks,
	};
	return {
		kind: "harnessy.calendar.plan-inspection" as const,
		plan,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		legacyApplyReportPresent: existsSync(join(dirname(path), `${plan.plan_id}.apply.json`)),
		publicationAuthorized: false as const,
	};
};
