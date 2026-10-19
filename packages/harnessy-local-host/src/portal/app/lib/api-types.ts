/**
 * Response types of the portal API, taken from the Core schemas so the app and
 * the server cannot drift. Type-only: nothing from Core is bundled.
 */
import type { Static } from "typebox";

import type {
	CommunityResponseSchema,
	ConnectionsResponseSchema,
	HealthResponseSchema,
	InboxResponseSchema,
	JobsResponseSchema,
	LearningResponseSchema,
	LifeBriefResponseSchema,
	LifeWeeklyDraftResponseSchema,
	MeetingsResponseSchema,
	TasksResponseSchema,
	TodayResponseSchema,
} from "../../../../../harnessy-core/src/read-model/api-schemas.ts";

export type { ConnectionData as Connection } from "../../../../../harnessy-core/src/read-model/api-schemas.ts";
export type {
	AppActionData as AppAction,
	CommunityGenerationData,
	FathomAccountsData,
	InboxItemData as InboxItem,
	InboxListData,
	JobData as Job,
	JobListData,
	TaskData as Task,
	TaskListData,
} from "../../../../../harnessy-core/src/read-model/app-schemas.ts";

export type TodayResponse = Static<typeof TodayResponseSchema>;
export type HealthResponse = Static<typeof HealthResponseSchema>;
export type ConnectionsResponse = Static<typeof ConnectionsResponseSchema>;
export type MeetingsResponse = Static<typeof MeetingsResponseSchema>;
export type CommunityResponse = Static<typeof CommunityResponseSchema>;
export type LearningResponse = Static<typeof LearningResponseSchema>;
export type InboxResponse = Static<typeof InboxResponseSchema>;
export type LifeBriefResponse = Static<typeof LifeBriefResponseSchema>;
export type LifeWeeklyDraftResponse = Static<typeof LifeWeeklyDraftResponseSchema>;
export type TasksResponse = Static<typeof TasksResponseSchema>;
export type JobsResponse = Static<typeof JobsResponseSchema>;

/** One tile: `data` is present only when `state` is `ok`. */
export interface Tile<A> {
	readonly state: "ok" | "missing" | "busy" | "recovering" | "unsupported" | "unsafe" | "error";
	readonly data?: A;
	readonly reason?: string;
	readonly readAt: string;
}
