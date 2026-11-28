import { z } from "zod";

const source = z.string().trim().min(1);
const instant = z.iso.datetime({ offset: true });
const day = z.iso.date();
const dateEvidence = z.strictObject({
	day,
	actionId: source.optional(),
	kind: z.enum(["manual", "plan", "promise", "chase"]),
	authority: z.enum(["human", "approved-plan", "direct-speaker", "generated"]),
	confidence: z.enum(["high", "medium", "low", "conflict"]),
	source,
});
// These are admitted observations. Providers must exclude canceled or duplicate
// events, withdrawn messages, resolved threads, outgoing mail and self-mail.
const calendarSignal = z.strictObject({ start: instant, relation: z.enum(["preparation", "agenda"]) });
const emailSignal = z.strictObject({ receivedAt: instant, relation: z.enum(["direct", "followup"]) });
export const actionEvidence = z.strictObject({
	id: source,
	kind: z.enum(["delivery", "decision", "chase"]),
	owner: z.enum(["self", "other", "unknown"]),
	state: z.enum(["open", "blocked", "pending_reverification", "closed"]).default("open"),
	source,
	importance: z.strictObject({ rule: z.enum(["I1", "I2", "I3", "I4"]), source }).optional(),
	dates: z.array(dateEvidence).default([]),
	calendar: z.array(calendarSignal).optional(),
	email: z.array(emailSignal).optional(),
	context: z.enum(["accepted", "request", "plan"]).optional(),
	contextAuthority: z.enum(["direct-speaker", "human", "generated"]).optional(),
	dependency: z.strictObject({ dependentActionId: source, verifiedBy: source, source }).optional(),
	estimate: z.strictObject({ minutes: z.number().int().positive(), estimatedBy: source }).optional(),
	observedAt: instant.optional(),
	progress: z
		.strictObject({
			at: instant,
			kind: z.enum(["delivery", "verified-partial", "accepted-material-scope-change"]),
			source,
		})
		.optional(),
	verifiedOverdueAt: instant.optional(),
});
export type PriorityAction = z.output<typeof actionEvidence>;
export const pinEvidence = z.strictObject({
	priority: z.number().int().min(0).max(10000),
	expiresAt: instant.nullable(),
	position: z.number().int().nonnegative().optional(),
});
export type PriorityPin = z.infer<typeof pinEvidence>;
export const priorityEvidence = z
	.strictObject({
		version: z.literal(1),
		tasks: z.array(
			z.strictObject({ taskId: z.uuid(), actions: z.array(actionEvidence).min(1), pin: pinEvidence.optional() }),
		),
	})
	.superRefine((input, ctx) => {
		const tasks = new Set<string>();
		const actions = new Set<string>();
		for (const task of input.tasks) {
			const key = task.taskId.toLowerCase();
			if (tasks.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate task ID" });
			tasks.add(key);
			for (const action of task.actions) {
				const id = action.id.toLowerCase();
				if (actions.has(id)) ctx.addIssue({ code: "custom", message: "Duplicate action ID" });
				actions.add(id);
			}
		}
	});
export type PriorityEvidence = z.output<typeof priorityEvidence>;

// Providers supply only linked and eligible observations. A resolved thread,
// unaccepted event, or calendar copy of a deadline is excluded at this boundary.
export type CalendarSignal = z.infer<typeof calendarSignal>;
export type EmailSignal = z.infer<typeof emailSignal>;
export type Availability<T> = readonly T[] | "unavailable";
export interface PriorityProviders {
	calendar(actionId: string, at: Date): Promise<Availability<CalendarSignal>>;
	email(actionId: string, at: Date): Promise<Availability<EmailSignal>>;
}
export const offlineProviders: PriorityProviders = {
	calendar: async () => "unavailable",
	email: async () => "unavailable",
};
