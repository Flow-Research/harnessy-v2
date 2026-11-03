/** HTTP v1 terminal contract. No UI, OS, process or provider imports. */
export const TERMINAL_API_VERSION = 1;

/** Host implementations retain private backend IDs; clients use opaque session IDs. */
export interface TerminalBackend {
	list(): object;
	read(id: string, cursor: number): object;
	action(value: unknown, actor?: string): unknown | Promise<unknown>;
	/** Disconnect the API host without ending independently owned processes. */
	close(): void;
}

export interface BriefSelection {
	readonly text: string;
	readonly source: string;
	readonly title: string;
}
