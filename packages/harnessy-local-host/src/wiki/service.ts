import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	canonicalizeReadingUrl,
	parseLifeResearchTopics,
	resolveLifeOrchestratorSettings,
	scanDeliveredLifeBriefs,
	type WikiEvidence,
	type WikiExecutor,
	type WikiModelRequest,
} from "@harnessy/core/wiki";
import { extract, passages } from "./evidence.ts";
import { hash, slug, type WikiStore } from "./store.ts";
import {
	boundedEvidence,
	escapeMarkdown,
	frontmatter,
	renderPage,
	sourcePage,
	stablePage,
	validateSynthesis,
} from "./synthesis.ts";

export const DEFAULT_TOPICS = [
	"Local-first AI and personal compute",
	"Transformer inference systems",
	"Cognitive architectures",
	"Automated knowledge economies",
	"Political economy of industrial development",
	"Public leadership and coalition building",
];

export function briefDate(path: string): string | null {
	const match = path.replaceAll("\\", "/").match(/\/(\d{4})\/([A-Za-z]{3})\/(\d{2})-daily-brief\.md$/);
	if (!match) return null;
	const month =
		["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[2] ?? "") + 1;
	const date = `${match[1]}-${String(month).padStart(2, "0")}-${match[3]}`;
	return month && new Date(`${date}T12:00:00Z`).toISOString().startsWith(date) ? date : null;
}

export function reconcile(store: WikiStore, homeRoot: string, projectRoot: string): number {
	store.assertWriter();
	const settings = resolveLifeOrchestratorSettings({ homeRoot, projectRoot });
	const topics = existsSync(settings.paths.steeringPath)
		? parseLifeResearchTopics(readFileSync(settings.paths.steeringPath, "utf8")).map(
				(topic) => topic.split(":")[0]?.trim() ?? topic,
			)
		: DEFAULT_TOPICS;
	store.setMeta("topics", JSON.stringify(topics.length ? topics : DEFAULT_TOPICS));
	let count = 0;
	if (existsSync(settings.paths.databasePath)) {
		const ledger = new DatabaseSync(settings.paths.databasePath, { readOnly: true });
		try {
			for (const row of ledger.prepare("SELECT * FROM reading_candidates WHERE status='delivered'").all()) {
				const path = String(row.delivered_brief ?? "");
				store.capture({
					uri: String(row.canonical_url),
					identity: String(row.identity),
					title: String(row.title),
					topics: [String(row.topic)],
					kind: "delivered",
					event: path || `ledger:${String(row.identity)}`,
					occurredAt: String(row.delivered_at ?? row.discovered_at),
					briefDate: briefDate(path),
				});
				count++;
			}
		} finally {
			ledger.close();
		}
	}
	for (const entry of scanDeliveredLifeBriefs(settings.paths.lifeDirectory).entries) {
		store.capture({
			uri: entry.url,
			kind: "delivered",
			event: entry.briefPath,
			occurredAt: entry.deliveredAt,
			briefDate: briefDate(entry.briefPath),
		});
		count++;
	}
	return count;
}

/** Reuse only matching evidence-bearing archive bodies, not discovery title stubs. */
function archiveEvidence(
	uri: string,
	archive: string,
): { bytes: Buffer; passages: ReturnType<typeof passages>; mode: "abstract" } | null {
	if (!existsSync(archive)) return null;
	for (const entry of readdirSync(archive, { withFileTypes: true }).slice(0, 3000)) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		if (statSync(join(archive, entry.name)).size > 250_000) continue;
		const text = readFileSync(join(archive, entry.name), "utf8").slice(0, 250_000);
		const front = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
		const archivedUrl = front?.[1]?.match(/^source_url:\s*["']?(https?:\/\/[^\s"']+)["']?\s*$/m)?.[1];
		if (!front || !archivedUrl || canonicalizeReadingUrl(archivedUrl) !== canonicalizeReadingUrl(uri)) continue;
		const body = text
			.slice(front[0].length)
			.replace(/^# .*\n|^Source:.*$/gm, "")
			.trim();
		if (body.length < 200) continue;
		return { bytes: Buffer.from(text), passages: passages(body), mode: "abstract" };
	}
	return null;
}

export interface SyncOptions {
	readonly homeRoot: string;
	readonly projectRoot: string;
	readonly refresh?: boolean;
	readonly captureOnly?: boolean;
	readonly fixtureOrigin?: string;
	readonly signal?: AbortSignal;
}

export async function syncWiki(
	store: WikiStore,
	execute: WikiExecutor,
	options: SyncOptions,
): Promise<Record<string, unknown>> {
	const signal = AbortSignal.any([AbortSignal.timeout(15 * 60_000), ...(options.signal ? [options.signal] : [])]);
	const scanned = await store.write(async () => reconcile(store, options.homeRoot, options.projectRoot));
	if (options.captureOnly) return { scanned, ...statusWiki(store) };
	const failures: string[] = [];
	let dropped: readonly string[] = [];
	let fetched = 0;
	let generated = 0;
	await store.write(async () => {
		const selected = store
			.sources()
			.filter((source) => {
				if (options.refresh || source.status !== "processed") return true;
				if (!/^https?:/i.test(source.uri)) {
					if (!existsSync(source.uri)) return true;
					const stat = statSync(source.uri);
					return store.meta(`file:${source.id}`) !== `${stat.size}:${stat.mtimeMs}`;
				}
				return Date.now() - Date.parse(store.meta(`attempt:${source.id}`) ?? "1970-01-01") > 7 * 86_400_000;
			})
			.sort((a, b) => (store.meta(`attempt:${a.id}`) ?? "").localeCompare(store.meta(`attempt:${b.id}`) ?? ""))
			.slice(0, 10);
		for (const source of selected) {
			if (signal.aborted) break;
			store.setMeta(`attempt:${source.id}`, new Date().toISOString());
			try {
				let evidence: Awaited<ReturnType<typeof extract>>;
				try {
					evidence = await extract(
						source.uri,
						AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
						options.fixtureOrigin,
					);
				} catch (error) {
					const archived = archiveEvidence(
						source.uri,
						join(options.homeRoot, ".jarvis", "wikis", "founder-learning", "raw", "articles"),
					);
					if (!archived) throw error;
					evidence = archived;
				}
				store.storeVersion(source.id, evidence.bytes, evidence.mode, evidence.passages);
				if (!/^https?:/i.test(source.uri)) {
					const stat = statSync(source.uri);
					store.setMeta(`file:${source.id}`, `${stat.size}:${stat.mtimeMs}`);
				}
				fetched++;
			} catch (error) {
				store.fail(source.id, error);
				failures.push(`${source.id}: ${error instanceof Error ? error.message : "extraction failed"}`);
			}
		}
	});
	if (!signal.aborted)
		await store
			.write(async () => {
				const topics = JSON.parse(store.meta("topics") ?? JSON.stringify(DEFAULT_TOPICS)) as string[];
				const pending = store
					.sources()
					.filter(
						(source) =>
							source.currentVersion &&
							store.meta(`compiled:${source.id}`) !==
								hash(JSON.stringify([source.currentVersion, source.topics])),
					)
					.slice(0, 6);
				if (!pending.length) return;
				const ids = new Set(pending.map((source) => source.id));
				const related = store
					.sources()
					.filter(
						(source) =>
							source.currentVersion &&
							!ids.has(source.id) &&
							source.topics.some((topic) => pending.some((item) => item.topics.includes(topic))),
					)
					.slice(-4);
				const evidence = boundedEvidence(
					[...pending, ...related].map((source) => ({
						source,
						version: store.version(source.currentVersion as string),
					})),
				);
				const relevantPages = store
					.pages()
					.filter((page) => !page.path.startsWith("sources/"))
					.slice(0, 12);
				// Source pages hold only captured evidence, so write them whether or not synthesis succeeds.
				for (const item of evidence) {
					const path = `sources/${item.version.id}.md`;
					if (
						stablePage(
							store,
							path,
							sourcePage({ source: item.source, version: store.version(item.version.id) }),
							store.pageHash(path),
						)
					)
						generated++;
				}
				const expected = new Map(store.pages().map((page) => [page.path, store.pageHash(page.path)]));
				let applying = false;
				try {
					const result = validateSynthesis(
						await execute(
							{
								task: "compile",
								instruction: `Update affected topics and concepts; include questions.md. Required topic pages: ${[...new Set(pending.flatMap((source) => source.topics))].map((topic) => `topics/${slug(topic)}.md`).join(", ")}. Preserve distinctions between evidence and synthesis. Classify unlabelled sources with the provided topics and cite each source used for a page.`,
								topics,
								evidence,
								pages: relevantPages.map((page) => ({
									path: page.path,
									markdown: page.markdown.slice(0, 5000),
								})),
							},
							signal,
						),
						evidence,
						store.pages().map((page) => page.path),
					);
					const omitted = [...(result.dropped ?? [])];
					const pages = result.pages.filter((page) => {
						if (!page.path.startsWith("reviews/")) return true;
						omitted.push(`${page.path}: Compilation cannot replace reviews`);
						return false;
					});
					if (!pages.length) throw new Error("No verified synthesis pages");
					for (const path of [
						"questions.md",
						...new Set(pending.flatMap((source) => source.topics).map((topic) => `topics/${slug(topic)}.md`)),
					])
						if (!pages.some((page) => page.path === path)) omitted.push(`${path}: not synthesized this run`);
					// Validate all destinations before applying any proposal.
					for (const page of pages)
						if (store.pageHash(page.path) !== (expected.get(page.path) ?? null))
							throw new Error(`Manual edit conflict: ${page.path}`);
					applying = true;
					dropped = omitted;
					for (const page of pages)
						if (stablePage(store, page.path, renderPage(page), expected.get(page.path) ?? null)) generated++;
					for (const source of pending) {
						if (!source.manualTopics) {
							const inferred = pages
								.filter((page) =>
									page.claims.some((claim) =>
										claim.citations.some((citation) => citation.versionId === source.currentVersion),
									),
								)
								.flatMap((page) => page.topics)
								.filter((topic) => topics.includes(topic));
							if (inferred.length)
								store.db
									.prepare("UPDATE sources SET topics=? WHERE id=?")
									.run(JSON.stringify([...new Set([...source.topics, ...inferred])]), source.id);
						}
						store.setMeta(
							`compiled:${source.id}`,
							hash(JSON.stringify([source.currentVersion, store.source(source.id).topics])),
						);
					}
					store.setMeta("lastSynthesisError", "");
					store.setMeta("lastSynthesisDropped", String(omitted.length));
				} catch (error) {
					if (applying) throw error;
					const message = error instanceof Error ? error.message : "Synthesis failed";
					failures.push(message);
					store.setMeta("lastSynthesisError", message);
				}
				for (const topic of topics) {
					const path = `topics/${slug(topic)}.md`;
					if (!store.pages().some((page) => page.path === path))
						stablePage(
							store,
							path,
							`${frontmatter(topic, "Section", [topic], [])}No synthesized evidence yet.\n`,
							null,
						);
				}
				const index =
					frontmatter("Personal learning library", "Section", topics, []) +
					"Capture, delivery, processing, reading and agreement are distinct. Personal notes are owned separately in the vault's notes directory.\n\n" +
					store
						.pages()
						.filter((page) => page.path !== "index.md")
						.map((page) => `- [${escapeMarkdown(page.path)}](${page.path})`)
						.join("\n") +
					"\n";
				stablePage(store, "index.md", index, store.pageHash("index.md"));
			})
			.catch(async (error) => {
				const message = error instanceof Error ? error.message : "Synthesis failed";
				failures.push(message);
				generated = 0;
				await store.write(async () => store.setMeta("lastSynthesisError", message));
			});
	return {
		scanned,
		fetched,
		generated,
		failures,
		dropped: dropped.slice(0, 20),
		droppedCount: dropped.length,
		...statusWiki(store),
	};
}

export function statusWiki(store: WikiStore): Record<string, unknown> {
	const sources = store.sources();
	return {
		captured: sources.length,
		processed: sources.filter((source) => source.status === "processed").length,
		pending: sources.filter((source) => source.status === "pending").length,
		failed: sources.filter((source) => source.status === "failed").length,
		synthesisPending: sources.filter(
			(source) =>
				source.currentVersion &&
				store.meta(`compiled:${source.id}`) !== hash(JSON.stringify([source.currentVersion, source.topics])),
		).length,
		synthesisError: store.meta("lastSynthesisError"),
		sources,
	};
}

export function queryContext(store: WikiStore, question: string): WikiModelRequest {
	const found = store.search(question);
	// Prioritize matching passages within each source before bounding context.
	const evidence = found.sources.map((item) => ({
		source: item.source,
		version: {
			...item.version,
			passages: [...item.version.passages].sort(
				(a, b) =>
					Number(found.passages.some((row) => row.version_id === item.version.id && row.locator === b.locator)) -
					Number(found.passages.some((row) => row.version_id === item.version.id && row.locator === a.locator)),
			),
		},
	}));
	return {
		task: "ask",
		instruction: question.slice(0, 4000),
		topics: [...new Set(found.sources.flatMap((item) => item.source.topics))],
		evidence: boundedEvidence(evidence),
		pages: found.pages.map((page) => ({ path: page.path, markdown: page.markdown.slice(0, 5000) })),
	};
}

export async function askWiki(
	store: WikiStore,
	execute: WikiExecutor,
	question: string,
): Promise<Record<string, unknown>> {
	const request = queryContext(store, question);
	if (!request.evidence.length)
		return { answer: "The library has no supporting evidence for this question.", citations: [], evidenceGap: true };
	const result = validateSynthesis(
		await execute(request, AbortSignal.timeout(120_000)),
		request.evidence,
		store.pages().map((page) => page.path),
	);
	if (result.pages.length !== 1) throw new Error("Answer must contain exactly one page");
	return {
		answer: renderPage(result.pages[0] as (typeof result.pages)[number]),
		claims: result.pages[0]?.claims,
		evidence: request.evidence.map((item) => ({ source: item.source, version: item.version.id })),
	};
}

export function isoWeek(date: Date): string {
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
	return `${d.getUTCFullYear()}-W${String(Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)).padStart(2, "0")}`;
}

export async function reviewWiki(
	store: WikiStore,
	execute: WikiExecutor,
	week: string,
): Promise<Record<string, unknown>> {
	if (!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(week)) throw new Error("Expected ISO week YYYY-Www");
	if (Number(week.slice(-2)) > Number(isoWeek(new Date(`${week.slice(0, 4)}-12-28T12:00:00Z`)).slice(-2)))
		throw new Error("ISO week does not exist in this year");
	const path = `reviews/${week}.md`;
	return store.write(async () => {
		const sources = store.sources().filter(
			(source) =>
				source.currentVersion &&
				(isoWeek(new Date(source.capturedAt)) === week ||
					store.db
						.prepare("SELECT occurred_at,brief_date FROM appearances WHERE source_id=?")
						.all(source.id)
						.some((row) => isoWeek(new Date(String(row.brief_date ?? row.occurred_at))) === week)),
		);
		const evidence: WikiEvidence[] = boundedEvidence(
			sources.map((source) => ({ source, version: store.version(source.currentVersion as string) })),
		);
		const fingerprint = hash(JSON.stringify(evidence));
		if (store.meta(`review:${week}`) === fingerprint && store.pageHash(path) !== null)
			return { path: store.safePath(`wiki/${path}`), changed: false };
		const expected = store.pageHash(path);
		const proposal = evidence.length
			? validateSynthesis(
					await execute(
						{
							task: "review",
							instruction: `Write ${path}: new connections, disagreements, and open questions for ${week}. Delivery does not imply reading.`,
							evidence,
							topics: [...new Set(sources.flatMap((source) => source.topics))],
							pages: store
								.pages()
								.filter((page) => page.path.startsWith("topics/") || page.path.startsWith("concepts/"))
								.slice(0, 6)
								.map((page) => ({ path: page.path, markdown: page.markdown.slice(0, 4000) })),
						},
						AbortSignal.timeout(120_000),
					),
					evidence,
					store.pages().map((page) => page.path),
				)
			: {
					pages: [
						{
							path,
							title: `Learning review ${week}`,
							topics: [],
							links: [],
							claims: [
								{
									kind: "gap" as const,
									text: "No processed evidence was captured or delivered this week.",
									citations: [],
								},
							],
						},
					],
				};
		if (proposal.pages.length !== 1 || proposal.pages[0]?.path !== path)
			throw new Error("Review returned unexpected page");
		for (const item of evidence) {
			const sourcePath = `sources/${item.version.id}.md`;
			stablePage(store, sourcePath, sourcePage(item), store.pageHash(sourcePath));
		}
		const changed = stablePage(store, path, renderPage(proposal.pages[0]), expected);
		const index = store.pages().find((page) => page.path === "index.md");
		if (index && !index.markdown.includes(`](${path})`))
			stablePage(
				store,
				"index.md",
				`${index.markdown}\n- [Learning review ${week}](${path})\n`,
				store.pageHash("index.md"),
			);
		store.setMeta(`review:${week}`, fingerprint);
		return {
			path: store.safePath(`wiki/${path}`),
			changed,
			week,
			sourceCount: sources.length,
			includedCount: evidence.length,
		};
	});
}

export function weeklyCompanionPath(lifeDirectory: string, date: Date): string {
	return join(
		lifeDirectory,
		String(date.getUTCFullYear()),
		date.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
		`${isoWeek(date)}-learning-review.md`,
	);
}
