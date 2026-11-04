/** Stable alert identity: elapsed Fathom age alone does not create a new alert. */
export const inboxRevision = (item: {
	key: string;
	title: string;
	severity: string;
	context: string;
	detail: string;
	since: string | null;
	actions: readonly unknown[];
}): string =>
	JSON.stringify([
		item.key,
		item.title,
		item.severity,
		item.key.startsWith("fathom:") && item.key.endsWith(":stale") ? "" : item.context,
		item.detail,
		item.since,
		item.actions,
	]);

export interface InboxSelection {
	key: string;
	revision: string;
}
