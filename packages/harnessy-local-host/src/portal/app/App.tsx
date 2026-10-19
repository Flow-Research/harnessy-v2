/**
 * The Harnessy app: sign-in, the frame, the screens, the palette and the
 * keyboard shortcuts (`g` + letter to change screen, ⌘K or Ctrl+K for the palette).
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { CommandChip } from "./components/actions.tsx";
import { ErrorBoundary, ScreenFailed } from "./components/ErrorBoundary.tsx";
import { Palette, type PaletteEntry, screenEntries } from "./components/Palette.tsx";
import { BottomBar, NAV, Rail, TopBar } from "./components/Shell.tsx";
import type { InboxResponse, JobsResponse, TasksResponse } from "./lib/api-types.ts";
import { applyTheme, effectiveTheme, storedTheme, type Theme } from "./lib/browser.ts";
import { type DataStore, useDataStore, useResource } from "./lib/data.tsx";
import { isTyping, type ScreenKeyHandler, ScreenKeysProvider } from "./lib/keys.tsx";
import { type HashLocation, routeHref, type Screen, useRoute } from "./lib/router.ts";
import type { SessionClient } from "./lib/session.ts";
import { ConnectionsScreen } from "./screens/Connections.tsx";
import { InboxScreen } from "./screens/Inbox.tsx";
import { JobsScreen } from "./screens/Jobs.tsx";
import { LearningScreen } from "./screens/Learning.tsx";
import { ReviewsScreen } from "./screens/Reviews.tsx";
import { TasksScreen } from "./screens/Tasks.tsx";
import { TodayScreen } from "./screens/Today.tsx";

/** Palette entries from data the app already holds. */
export const paletteEntries = (
	inbox: InboxResponse | undefined,
	jobs: JobsResponse | undefined,
	tasks: TasksResponse | undefined,
): ReadonlyArray<PaletteEntry> => {
	const entries: PaletteEntry[] = [...screenEntries()];
	if (inbox?.tiles.inbox.state === "ok")
		for (const item of inbox.tiles.inbox.data?.items ?? []) {
			entries.push({
				id: `inbox:${item.key}`,
				title: item.title,
				group: "Inbox",
				target: routeHref("inbox", item.key),
			});
			for (const action of item.actions)
				if (action.kind === "copy")
					entries.push({
						id: `inbox:${item.key}:${action.target}`,
						title: `${item.title}: ${action.label}`,
						group: "Commands",
						command: action.target,
					});
		}
	if (jobs?.tiles.jobs.state === "ok")
		for (const job of jobs.tiles.jobs.data?.jobs ?? []) {
			entries.push({ id: `job:${job.id}`, title: job.name, group: "Jobs", target: routeHref("jobs", job.id) });
			for (const control of job.controls)
				if (control.kind === "copy")
					entries.push({
						id: `job:${job.id}:${control.label}`,
						title: `${job.name}: ${control.label}`,
						group: "Commands",
						command: control.target,
					});
		}
	if (tasks?.tiles.tasks.state === "ok")
		for (const task of tasks.tiles.tasks.data?.tasks ?? [])
			entries.push({ id: `task:${task.id}`, title: task.title, group: "Tasks", command: task.title });
	const unique = new Map<string, PaletteEntry>();
	for (const entry of entries) if (!unique.has(entry.id)) unique.set(entry.id, entry);
	return [...unique.values()];
};

const SignedOut = () => (
	<main className="signed-out">
		<h1 className="screen-title">Sign in to Harnessy</h1>
		<p className="text-2">
			The sign-in is read-only and lasts 8 hours in this tab. It also ends when the portal restarts. Run this, and
			your browser opens a fresh link:
		</p>
		<CommandChip command="harnessy open" />
	</main>
);

const ScreenView = ({ screen, rest, now }: { screen: Screen; rest: ReadonlyArray<string>; now: number }) => {
	switch (screen) {
		case "inbox":
			return <InboxScreen selectedKey={rest[0]} now={now} />;
		case "today":
			return <TodayScreen rest={rest} now={now} />;
		case "tasks":
			return <TasksScreen rest={rest} />;
		case "jobs":
			return <JobsScreen rest={rest} now={now} />;
		case "reviews":
			return <ReviewsScreen rest={rest} />;
		case "learning":
			return <LearningScreen now={now} />;
		case "connections":
			return <ConnectionsScreen rest={rest} />;
	}
};

const SignedIn = ({ location, client }: { location: HashLocation; client: SessionClient }) => {
	const store = useDataStore();
	const route = useRoute(location);
	const [now, setNow] = useState(() => Date.now());
	const [theme, setTheme] = useState<Theme>(() => effectiveTheme());
	const [palette, setPalette] = useState(false);
	const inbox = useResource<InboxResponse>("/v1/inbox");
	const jobs = useResource<JobsResponse>("/v1/jobs");
	// The palette searches tasks: while it is open it reads them, even before the Tasks screen has.
	const paletteTasks = useResource<TasksResponse>(palette ? "/v1/tasks" : null);
	const tasks = paletteTasks.data ?? (store.get("/v1/tasks").data as TasksResponse | undefined);

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 5_000);
		return () => clearInterval(timer);
	}, []);
	useEffect(() => {
		if (storedTheme() !== undefined) applyTheme(theme, false);
	}, [theme]);
	// The only window key listener: global shortcuts first, then the current screen's handler.
	const screenKeys = useRef<ScreenKeyHandler | null>(null);
	const paletteOpen = useRef(palette);
	paletteOpen.current = palette;
	useEffect(() => {
		let pendingG = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setPalette((open) => !open);
				return;
			}
			// The palette handles its own keys while it is open.
			if (paletteOpen.current || event.defaultPrevented) return;
			if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
			if (pendingG) {
				// The key after `g` belongs to the chord, whether or not it names a screen.
				pendingG = false;
				clearTimeout(timer);
				const destination = NAV.find((item) => item.key === event.key);
				if (destination !== undefined) {
					event.preventDefault();
					location.setHash(routeHref(destination.screen));
				}
				return;
			}
			if (event.key === "g") {
				pendingG = true;
				timer = setTimeout(() => {
					pendingG = false;
				}, 1_000);
				return;
			}
			screenKeys.current?.(event);
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			clearTimeout(timer);
		};
	}, [location]);

	const badges = {
		inbox: inbox.data?.tiles.inbox.state === "ok" ? (inbox.data.tiles.inbox.data?.counts.action_required ?? 0) : 0,
		jobs: jobs.data?.tiles.jobs.state === "ok" ? (jobs.data.tiles.jobs.data?.errorCount ?? 0) : 0,
	};
	const entries = useMemo(() => paletteEntries(inbox.data, jobs.data, tasks), [inbox.data, jobs.data, tasks]);

	return (
		<div className="app">
			{/* A button, not `href="#main"`: in a hash-routed app that link would change the route. */}
			<button type="button" className="skip-link" onClick={() => document.getElementById("main")?.focus()}>
				Skip to content
			</button>
			<Rail current={route.screen} sub={route.rest[0]} badges={badges} />
			<div className="main-column">
				<TopBar
					screen={route.screen}
					sub={route.rest[0]}
					fetchedAt={inbox.fetchedAt}
					now={now}
					sessionExpiresAt={client.session()?.expiresAt}
					theme={theme}
					onToggleTheme={() => {
						const next = theme === "dark" ? "light" : "dark";
						applyTheme(next, true);
						setTheme(next);
					}}
					onOpenPalette={() => setPalette(true)}
					onRefresh={() => void store.refreshAll()}
				/>
				<main id="main" className="content" tabIndex={-1}>
					<ScreenKeysProvider handler={screenKeys}>
						<ErrorBoundary fallback={<ScreenFailed />} resetKey={`${route.screen}/${route.rest.join("/")}`}>
							<ScreenView screen={route.screen} rest={route.rest} now={now} />
						</ErrorBoundary>
					</ScreenKeysProvider>
				</main>
			</div>
			<BottomBar current={route.screen} badges={badges} />
			{palette ? <Palette entries={entries} onClose={() => setPalette(false)} /> : null}
		</div>
	);
};

/** Sign in from the URL first, then show the app or the sign-in help. */
export const App = ({
	client,
	store,
	location,
}: {
	client: SessionClient;
	store: DataStore;
	location: HashLocation;
}) => {
	const [state, setState] = useState<"starting" | "signed_in" | "signed_out">("starting");
	useEffect(() => {
		let cancelled = false;
		const check = async () => {
			if (location.hash().startsWith("#code=")) {
				await client.signInFromHash();
				store.reset();
			}
			if (!cancelled) setState(client.session() === undefined ? "signed_out" : "signed_in");
		};
		void check();
		const unsubscribeHash = location.subscribe(() => {
			if (location.hash().startsWith("#code=")) void check();
		});
		const unsubscribeSignedOut = store.onSignedOut(() => setState("signed_out"));
		return () => {
			cancelled = true;
			unsubscribeHash();
			unsubscribeSignedOut();
		};
	}, [client, store, location]);
	if (state === "starting") return <p className="muted starting">Loading</p>;
	return state === "signed_out" ? <SignedOut /> : <SignedIn location={location} client={client} />;
};
