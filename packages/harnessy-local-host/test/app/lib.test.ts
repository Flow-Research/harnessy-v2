/**
 * The app's browser libraries, without a DOM: link checks, the hash router, the
 * Markdown parser (with a hostile corpus), formatting, sign-in and the shared
 * data store.
 */
import { describe, expect, it } from "vitest";

import { DataStore } from "../../src/portal/app/lib/data.tsx";
import { dateTime, dayLabel, greeting, plural, relativeTime } from "../../src/portal/app/lib/format.ts";
import {
	type Block,
	inlineText,
	MAX_BLOCKS,
	MAX_QUOTE_DEPTH,
	parseInline,
	parseMarkdown,
	sectionsOf,
} from "../../src/portal/app/lib/markdown.ts";
import { parseRoute, routeHref } from "../../src/portal/app/lib/router.ts";
import { safeAppRoute, safeHref } from "../../src/portal/app/lib/safe-href.ts";
import {
	type FetchInit,
	type FetchResponse,
	SessionClient,
	type SessionEnvironment,
	type SessionStore,
	TOKEN_KEY,
} from "../../src/portal/app/lib/session.ts";

describe("links", () => {
	it("accepts only explicit-port loopback http links without credentials, query or fragment", () => {
		expect(safeHref("http://127.0.0.1:8770/")).toBe("http://127.0.0.1:8770/");
		expect(safeHref("http://localhost:4788/")).toBe("http://localhost:4788/");
		// A review service configured with reviewHost ::1 listens on IPv6 loopback only.
		expect(safeHref("http://[::1]:8770/")).toBe("http://[::1]:8770/");
		for (const value of [
			"javascript:alert(1)",
			"data:text/html,<script>x</script>",
			"https://127.0.0.1:8770/",
			"http://127.0.0.1/",
			"http://example.test:80/",
			"http://user:pass@127.0.0.1:8770/",
			"http://127.0.0.1:8770/?token=x",
			"http://127.0.0.1:8770/#x",
			"http://127.0.0.1:8770/a b",
			"http://[::1]/",
			"http://[::2]:8770/",
			"http://[::ffff:7f00:1]:8770/",
			`http://127.0.0.1:8770/${"a".repeat(300)}`,
			"not a url",
			"http//127.0.0.1:8770/",
			42,
			null,
		])
			expect([value, safeHref(value)]).toEqual([value, undefined]);
		expect(safeAppRoute("#/jobs/fathom-poll")).toBe("#/jobs/fathom-poll");
		for (const value of ["#/../x", "javascript:x", "#/a?b", "/jobs", 1]) expect(safeAppRoute(value)).toBeUndefined();
	});
});

describe("router", () => {
	it("parses screens and decoded segments, falling back to the inbox", () => {
		expect(parseRoute("")).toEqual({ screen: "inbox", rest: [] });
		expect(parseRoute("#/jobs/fathom-poll")).toEqual({ screen: "jobs", rest: ["fathom-poll"] });
		expect(parseRoute("#/inbox/community%3Apending")).toEqual({ screen: "inbox", rest: ["community:pending"] });
		expect(parseRoute("#/inbox/%E0%A4%A")).toEqual({ screen: "inbox", rest: ["%E0%A4%A"] });
		expect(parseRoute("#/nowhere/x")).toEqual({ screen: "inbox", rest: [] });
		expect(parseRoute("#code=abc")).toEqual({ screen: "inbox", rest: [] });
		expect(routeHref("inbox", "community:pending")).toBe("#/inbox/community%3Apending");
		expect(routeHref("today")).toBe("#/today");
	});
});

const text = (blocks: ReadonlyArray<Block>): string => JSON.stringify(blocks);

describe("markdown", () => {
	it("parses headings, lists with continuation and nesting, quotes, code, rules and tables to a tree", () => {
		const blocks = parseMarkdown(
			[
				"# Title",
				"",
				"Para one",
				"continues here.",
				"",
				"1. **Bold lead.** detail",
				"   continuation",
				"   - nested one",
				"     nested continuation",
				"2. second",
				"",
				"- [x] done",
				"- [ ] open",
				"",
				"> quoted *em* text",
				"",
				"```",
				"<b>code</b>",
				"```",
				"",
				"---",
				"",
				"| a | b |",
				"| --- | --- |",
				"| 1 | `2` |",
			].join("\n"),
		);
		expect(blocks.map((block) => block.type)).toEqual([
			"heading",
			"paragraph",
			"list",
			"list",
			"quote",
			"code",
			"rule",
			"table",
		]);
		expect(inlineText((blocks[1] as { children: Parameters<typeof inlineText>[0] }).children)).toBe(
			"Para one continues here.",
		);
		const ordered = blocks[2] as Extract<Block, { type: "list" }>;
		expect(ordered.ordered).toBe(true);
		expect(ordered.items[0]!.children[0]).toEqual({
			type: "strong",
			children: [{ type: "text", text: "Bold lead." }],
		});
		expect(inlineText(ordered.items[0]!.children)).toBe("Bold lead. detail continuation");
		expect(inlineText(ordered.items[0]!.sublist!.items[0]!.children)).toBe("nested one nested continuation");
		expect((blocks[3] as Extract<Block, { type: "list" }>).items.map((item) => item.checked)).toEqual([true, false]);
		expect(blocks[5]).toEqual({ type: "code", text: "<b>code</b>" });
		expect(blocks[7]).toMatchObject({
			type: "table",
			header: [[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]],
		});
	});

	it("keeps raw HTML, script, javascript: links and bidi controls as data, never markup", () => {
		const corpus = [
			"<script>alert(1)</script>",
			'<img src=x onerror="alert(1)">',
			"[click](javascript:alert(1))",
			"[ok](http://127.0.0.1:8770/)",
			"‮gnp.exe‬ and ⁦isolate⁩",
			"<style>body{display:none}</style>",
		].join("\n\n");
		const blocks = parseMarkdown(corpus);
		const serialized = text(blocks);
		expect(serialized).toContain("<script>alert(1)</script>");
		// A target with parentheses is not a link at all; it stays text.
		expect(serialized).toContain("[click](javascript:alert(1))");
		expect(serialized).toContain('{"type":"link","href":"http://127.0.0.1:8770/"');
		expect(blocks.every((block) => block.type === "paragraph")).toBe(true);
		expect(serialized).toContain("‮");
		expect(parseInline("a * b * c")).toEqual([{ type: "text", text: "a * b * c" }]);
		expect(parseInline("snake_case_word")).toEqual([{ type: "text", text: "snake_case_word" }]);
		expect(inlineText(parseInline(`${"**".repeat(20)}x${"**".repeat(20)}`))).toContain("x");
	});

	it("bounds the number of blocks and always terminates", () => {
		const blocks = parseMarkdown(Array.from({ length: MAX_BLOCKS + 50 }, (_, index) => `# h${index}`).join("\n"));
		expect(blocks).toHaveLength(MAX_BLOCKS);
		expect(parseMarkdown("```\nunterminated")).toEqual([{ type: "code", text: "unterminated" }]);
		expect(parseMarkdown(" - one-space bullet\n  - nested")).toHaveLength(1);
		expect(parseMarkdown("|not a table|")).toEqual([
			{ type: "paragraph", children: [{ type: "text", text: "|not a table|" }] },
		]);
	});

	it("bounds block-quote nesting, so a long run of `>` neither overflows the stack nor vanishes", () => {
		const depthOf = (blocks: ReadonlyArray<Block>): number => {
			const quote = blocks.find((block) => block.type === "quote");
			return quote === undefined ? 0 : 1 + depthOf(quote.children);
		};
		for (const source of [">".repeat(20_000), `${">".repeat(5_000)} deep`, Array(30_000).fill(">").join("\n")]) {
			const blocks = parseMarkdown(source);
			expect(depthOf(blocks)).toBeLessThanOrEqual(MAX_QUOTE_DEPTH);
		}
		// The text past the limit is kept as written, `>` included.
		const deep = parseMarkdown(`${">".repeat(MAX_QUOTE_DEPTH + 3)} deep`);
		expect(depthOf(deep)).toBe(MAX_QUOTE_DEPTH);
		expect(JSON.stringify(deep)).toContain(`${">".repeat(2)} deep`);
		// Ordinary nesting below the limit is unchanged.
		expect(depthOf(parseMarkdown("> > > three"))).toBe(3);
	});

	it("splits a brief into sections at level-2 headings", () => {
		const sections = sectionsOf(parseMarkdown("intro\n\n## One\n\n- a\n\n## Two\n\ntext\n\n### Sub\n\nmore"));
		expect(sections.map((section) => [section.title, section.blocks.length])).toEqual([
			[null, 1],
			["One", 1],
			["Two", 3],
		]);
	});
});

describe("format", () => {
	const now = Date.parse("2026-10-17T08:00:00.000Z");
	it("shows relative and Lagos times without locale surprises", () => {
		expect(relativeTime("2026-10-17T07:59:56.000Z", now)).toBe("4 s ago");
		expect(relativeTime("2026-10-17T07:48:00.000Z", now)).toBe("12 min ago");
		expect(relativeTime("2026-10-17T05:00:00.000Z", now)).toBe("3 h ago");
		expect(relativeTime("2026-10-14T08:00:00.000Z", now)).toBe("3 d ago");
		expect(relativeTime("2026-10-17T08:05:00.000Z", now)).toBe("in 5 min");
		expect(relativeTime("nonsense", now)).toBe("unknown");
		expect(relativeTime(null, now)).toBe("unknown");
		expect(dateTime("2026-10-18T22:00:00.000Z")).toBe("Sun 18 Oct, 23:00");
		expect(dateTime(undefined)).toBe("unknown");
		expect(dayLabel("2026-09-07")).toBe("Mon 7 Sep");
		expect(dayLabel("bad")).toBe("bad");
		expect(greeting(Date.parse("2026-10-17T06:00:00Z"))).toBe("Good morning");
		expect(greeting(Date.parse("2026-10-17T13:00:00Z"))).toBe("Good afternoon");
		expect(greeting(Date.parse("2026-10-17T20:00:00Z"))).toBe("Good evening");
		expect(plural(1, "thing")).toBe("1 thing");
		expect(plural(2, "thing")).toBe("2 things");
	});
});

class MemoryStore implements SessionStore {
	readonly values = new Map<string, string>();
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.values.set(key, value);
	}
	removeItem(key: string) {
		this.values.delete(key);
	}
}

const TOKEN = "t".repeat(43);
const CODE = "c".repeat(43);

const environment = (
	hash: string,
	answer: (path: string, init: FetchInit) => FetchResponse | Promise<FetchResponse>,
	storage: SessionStore | undefined = new MemoryStore(),
) => {
	const urls: string[] = [];
	const calls: Array<{ path: string; init: FetchInit }> = [];
	const env: SessionEnvironment = {
		hash: () => hash,
		replaceUrl: (url) => urls.push(url),
		storage,
		fetch: async (path, init) => {
			calls.push({ path, init });
			return answer(path, init);
		},
		now: () => Date.parse("2026-10-17T08:00:00.000Z"),
	};
	return { env, urls, calls };
};

const json = (status: number, body: unknown): FetchResponse => ({ status, json: async () => body });

describe("session", () => {
	it("clears the code from the address bar first, exchanges it once and reads with a bearer token and no cookies", async () => {
		const { env, urls, calls } = environment(`#code=${CODE}&route=jobs`, (path) =>
			path === "/v1/session/exchange"
				? json(200, { token: TOKEN, scope: "read", expiresAt: "2026-10-17T16:00:00.000Z" })
				: json(200, { ok: true }),
		);
		const client = new SessionClient(env);
		expect(await client.signInFromHash()).toBe("jobs");
		expect(urls).toEqual(["/#/jobs"]);
		expect(calls[0]).toEqual({
			path: "/v1/session/exchange",
			init: {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code: CODE }),
				credentials: "omit",
				cache: "no-store",
				redirect: "error",
			},
		});
		expect(client.session()).toEqual({ token: TOKEN, expiresAt: Date.parse("2026-10-17T16:00:00.000Z") });
		expect(await client.get("/v1/inbox")).toEqual({ kind: "ok", body: { ok: true } });
		expect(calls[1]!.init).toEqual({
			method: "GET",
			headers: { Authorization: `Bearer ${TOKEN}` },
			credentials: "omit",
			cache: "no-store",
			redirect: "error",
		});
	});

	it("lands on the inbox for an unknown route, and stays signed out for a malformed or refused code", async () => {
		const malformed = environment("#code=short", () => json(200, {}));
		const client = new SessionClient(malformed.env);
		expect(await client.signInFromHash()).toBe("inbox");
		expect(malformed.urls).toEqual(["/#/inbox"]);
		expect(malformed.calls).toEqual([]);
		expect(await client.get("/v1/inbox")).toEqual({ kind: "signed_out" });
		for (const answer of [
			() => json(401, { error: "invalid_code" }),
			() => json(200, { token: "bad", expiresAt: "2026-10-17T16:00:00.000Z" }),
			() => json(200, { token: TOKEN, expiresAt: "never" }),
			() => {
				throw new Error("offline");
			},
		]) {
			const refused = new SessionClient(environment(`#code=${CODE}&route=nowhere`, answer).env);
			expect(await refused.signInFromHash()).toBe("inbox");
			expect(refused.session()).toBeUndefined();
		}
		expect(await new SessionClient(environment("#/jobs", () => json(200, {})).env).signInFromHash()).toBeUndefined();
	});

	it("reads a stored session, forgets only a refused token, and reports errors without throwing", async () => {
		const storage = new MemoryStore();
		storage.setItem(TOKEN_KEY, JSON.stringify({ token: TOKEN, expiresAt: Date.parse("2026-10-17T16:00:00.000Z") }));
		let status = 500;
		const { env } = environment("", () => json(status, {}), storage);
		const client = new SessionClient(env);
		expect(client.session()?.token).toBe(TOKEN);
		expect(await client.get("/v1/jobs")).toEqual({ kind: "error", message: "The portal answered 500." });
		status = 401;
		client.forget("other-token");
		expect(client.session()?.token).toBe(TOKEN);
		expect(await client.get("/v1/jobs")).toEqual({ kind: "signed_out" });
		expect(storage.getItem(TOKEN_KEY)).toBeNull();
		const offline = new SessionClient(
			environment(
				"",
				() => {
					throw new Error("offline");
				},
				storage,
			).env,
		);
		storage.setItem(TOKEN_KEY, JSON.stringify({ token: TOKEN, expiresAt: Date.parse("2026-10-17T16:00:00.000Z") }));
		expect(await offline.get("/v1/jobs")).toMatchObject({ kind: "error" });
		storage.setItem(TOKEN_KEY, "{ not json");
		expect(new SessionClient(environment("", () => json(200, {}), storage).env).session()).toBeUndefined();
		storage.setItem(TOKEN_KEY, JSON.stringify({ token: TOKEN, expiresAt: 0 }));
		expect(new SessionClient(environment("", () => json(200, {}), storage).env).session()).toBeUndefined();
		const throwing: SessionStore = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
		};
		const blocked = new SessionClient(
			environment(
				`#code=${CODE}`,
				() => json(200, { token: TOKEN, expiresAt: "2026-10-17T16:00:00.000Z" }),
				throwing,
			).env,
		);
		await blocked.signInFromHash();
		// Storage refused the token, but the session still works for this load from memory.
		expect(blocked.session()?.token).toBe(TOKEN);
		const memoryOnly = new SessionClient(
			environment(
				`#code=${CODE}`,
				() => json(200, { token: TOKEN, expiresAt: "2026-10-17T16:00:00.000Z" }),
				undefined,
			).env,
		);
		await memoryOnly.signInFromHash();
		expect(memoryOnly.session()?.token).toBe(TOKEN);
		memoryOnly.forget(TOKEN);
		expect(memoryOnly.session()).toBeUndefined();
	});
});

describe("data store", () => {
	it("shares one fetch per path, keeps old data on error and reports a sign-out", async () => {
		const answers: Array<
			() => { kind: "ok"; body: unknown } | { kind: "error"; message: string } | { kind: "signed_out" }
		> = [
			() => ({ kind: "ok", body: { n: 1 } }),
			() => ({ kind: "error", message: "down" }),
			() => ({ kind: "signed_out" }),
		];
		let calls = 0;
		const store = new DataStore({ get: async () => answers[calls++]!() }, () => 1_000);
		let notified = 0;
		const unsubscribe = store.subscribe("/v1/inbox", () => {
			notified += 1;
		});
		let signedOut = 0;
		store.onSignedOut(() => {
			signedOut += 1;
		});
		expect(store.get("/v1/inbox")).toEqual({ status: "loading" });
		await Promise.all([store.refresh("/v1/inbox"), store.refresh("/v1/inbox")]);
		expect(calls).toBe(1);
		expect(store.get("/v1/inbox")).toEqual({ status: "ok", data: { n: 1 }, fetchedAt: 1_000 });
		await store.refreshAll();
		expect(store.get("/v1/inbox")).toEqual({ status: "error", message: "down", data: { n: 1 }, fetchedAt: 1_000 });
		await store.refresh("/v1/inbox");
		expect(store.get("/v1/inbox")).toEqual({ status: "signed_out" });
		expect([notified, signedOut]).toEqual([3, 1]);
		unsubscribe();
		store.reset();
		expect(store.get("/v1/inbox")).toEqual({ status: "loading" });
	});
});
