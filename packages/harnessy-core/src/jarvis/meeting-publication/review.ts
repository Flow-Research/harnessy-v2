import { isUtf8 } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
	JARVIS_MEETING_PUBLICATION_REVIEW_MAX_BODY_BYTES,
	type JarvisMeetingPublicationConfig,
} from "../config-model.ts";
import { MeetingPublicationWriteAuthority, resolveMeetingPublicationWriteBinding } from "./authority.ts";
import { authorizeMeetingPublicationWrite } from "./authority-check.ts";
import {
	MeetingPublicationFailureStage,
	type MeetingPublicationItem,
	type MeetingPublicationPreflightResult,
	MeetingPublicationReviewAddress,
	MeetingPublicationReviewError,
	MeetingPublicationStatus,
} from "./models.ts";
import { MEETING_PUBLICATION_NOTE_MAX_LENGTH, MeetingPublicationSource } from "./notes.ts";
import {
	redactMeetingPublicationReviewText,
	renderMeetingPublicationReviewMarkdown,
	renderMeetingPublicationReviewNote,
} from "./review-markdown.ts";
import {
	MEETING_PUBLICATION_PURPOSE_MAX_LENGTH,
	MeetingPublicationClock,
	MeetingPublicationService,
	meetingPublicationDefaultPurpose,
} from "./service.ts";
import { MeetingPublicationStore } from "./store.ts";

const cookieName = "hsy_meeting_review";
const tokenFileName = "meeting-publication-v2-review.token";
export const meetingPublicationReviewRendezvousFileName = "meeting-publication-v2-review.rendezvous.json";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const itemIdPattern = /^[a-f0-9]{24}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const formContentType = "application/x-www-form-urlencoded";

const publishRendezvous = (stateRoot: string, origin: string, port: number) => {
	const path = resolve(stateRoot, meetingPublicationReviewRendezvousFileName);
	const temporary = resolve(stateRoot, `.${meetingPublicationReviewRendezvousFileName}.tmp`);
	const body = `${JSON.stringify({ kind: "harnessy.meeting-publication.review-rendezvous.v1", origin, port, tokenPath: resolve(stateRoot, tokenFileName) })}\n`;
	writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
	return path;
};

interface ReviewSession {
	readonly csrf: string;
	readonly createdAt: number;
	readonly expiresAt: number;
}

export type MeetingPublicationReviewMode = "full" | "decision_only";

class ReviewHttpError extends Error {
	readonly status: number;
	readonly title: string;

	constructor(status: number, title: string) {
		super(title);
		this.status = status;
		this.title = title;
	}
}

export class MeetingPublicationReviewRandom extends Context.Service<
	MeetingPublicationReviewRandom,
	{ readonly bytes: (length: number) => Effect.Effect<Uint8Array, MeetingPublicationReviewError> }
>()("@harnessy/core/MeetingPublicationReviewRandom") {
	static readonly liveLayer = Layer.succeed(
		MeetingPublicationReviewRandom,
		MeetingPublicationReviewRandom.of({
			bytes: (length) =>
				Effect.try({
					try: () => randomBytes(length),
					catch: () => new MeetingPublicationReviewError({ code: "server_failed" }),
				}),
		}),
	);
}

const secureEqual = (left: string, right: string) => {
	const leftDigest = createHash("sha256").update(left).digest();
	const rightDigest = createHash("sha256").update(right).digest();
	return timingSafeEqual(leftDigest, rightDigest);
};

const encodeRandom = (bytes: Uint8Array, expectedLength: number) => {
	if (bytes.byteLength !== expectedLength) throw new MeetingPublicationReviewError({ code: "server_failed" });
	return Buffer.from(bytes).toString("base64url");
};

const deriveRandom = (bytes: Uint8Array, domain: string, outputLength = 32) => {
	if (bytes.byteLength !== 32 || outputLength < 1 || outputLength > 32) {
		throw new MeetingPublicationReviewError({ code: "server_failed" });
	}
	return createHash("sha256")
		.update("harnessy-meeting-review\0", "utf8")
		.update(domain, "utf8")
		.update("\0", "utf8")
		.update(bytes)
		.digest()
		.subarray(0, outputLength);
};

const chmodOwnerOnly = (path: string, mode: number) => {
	if (process.platform !== "win32") {
		const actual = lstatSync(path).mode & 0o777;
		if (actual !== mode) throw new MeetingPublicationReviewError({ code: "unsafe_token_state" });
	}
};

const readExistingToken = (path: string) => {
	const pathStat = lstatSync(path, { bigint: true });
	if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n || pathStat.size !== 44n) {
		throw new MeetingPublicationReviewError({ code: "unsafe_token_state" });
	}
	chmodOwnerOnly(path, 0o600);
	const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const descriptorStat = fstatSync(descriptor, { bigint: true });
		if (descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino || descriptorStat.nlink !== 1n) {
			throw new MeetingPublicationReviewError({ code: "unsafe_token_state" });
		}
		const bytes = readFileSync(descriptor);
		if (!isUtf8(bytes)) throw new MeetingPublicationReviewError({ code: "unsafe_token_state" });
		const encoded = bytes.toString("utf8");
		if (!/^[A-Za-z0-9_-]{43}\n$/u.test(encoded)) {
			throw new MeetingPublicationReviewError({ code: "unsafe_token_state" });
		}
		return encoded.slice(0, -1);
	} finally {
		closeSync(descriptor);
	}
};

const loadOrCreateToken = Effect.fn("MeetingPublicationReview.loadOrCreateToken")(function* (
	stateRoot: string,
	random: MeetingPublicationReviewRandom["Service"],
) {
	return yield* Effect.tryPromise({
		try: async () => {
			chmodOwnerOnly(stateRoot, 0o700);
			const path = resolve(stateRoot, tokenFileName);
			if (dirname(path) !== stateRoot) throw new MeetingPublicationReviewError({ code: "unsafe_token_state" });
			if (existsSync(path)) return readExistingToken(path);
			const token = encodeRandom(deriveRandom(await Effect.runPromise(random.bytes(32)), "bootstrap"), 32);
			const suffix = encodeRandom(
				deriveRandom(await Effect.runPromise(random.bytes(32)), "bootstrap-temporary", 12),
				12,
			);
			const temporary = resolve(stateRoot, `.${tokenFileName}.${suffix}.tmp`);
			let descriptor: number | null = null;
			try {
				descriptor = openSync(
					temporary,
					constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
					0o600,
				);
				writeFileSync(descriptor, `${token}\n`, "utf8");
				fsyncSync(descriptor);
				closeSync(descriptor);
				descriptor = null;
				chmodOwnerOnly(temporary, 0o600);
				linkSync(temporary, path);
				unlinkSync(temporary);
				return readExistingToken(path);
			} finally {
				if (descriptor !== null) closeSync(descriptor);
				if (existsSync(temporary)) unlinkSync(temporary);
			}
		},
		catch: (cause) =>
			cause instanceof MeetingPublicationReviewError
				? cause
				: new MeetingPublicationReviewError({ code: "unsafe_token_state" }),
	});
});

const escapeHtml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

const safeReviewText = (value: string) => escapeHtml(redactMeetingPublicationReviewText(value));

const reviewStyles = `
:root { color-scheme: light; --canvas: #f3f6f4; --surface: #fff; --ink: #15201a;
--muted: #647068; --line: #dce4df; --accent: #167449; --accent-dark: #105b39;
--danger: #a33b3b; --discord: #313338; }
* { box-sizing: border-box; }
body { background: var(--canvas); color: var(--ink); font: 15px/1.65 -apple-system,
BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; }
body::before { background: linear-gradient(90deg, #126b43, #45a66f); content: "";
display: block; height: 5px; }
.back-link { align-items: center; color: #456052; display: flex; font-weight: 650; gap: .45rem;
margin: 2rem auto 0; max-width: 1220px; padding: 0 1.5rem; text-decoration: none; width: 100%; }
.back-link:hover { color: var(--accent); }
.page-intro, .meeting-header { margin: 0 auto; max-width: 1220px; padding: 3rem 1.5rem 2rem;
width: 100%; }
.page-intro { max-width: 920px; }
.intro-row { align-items: flex-end; display: flex; gap: 2rem; justify-content: space-between; }
.eyebrow, .section-label { color: var(--accent); font-size: .73rem; font-weight: 800;
letter-spacing: .1em; margin: 0 0 .45rem; text-transform: uppercase; }
h1, h2, h3 { color: var(--ink); line-height: 1.22; }
h1 { font-size: clamp(2rem, 5vw, 3.35rem); letter-spacing: -.035em; margin: .15rem 0 .8rem;
max-width: 980px; }
h2 { letter-spacing: -.018em; }
.lede { color: var(--muted); font-size: 1.05rem; margin: 0; }
.count-badge, .local-badge, .summary-badge { border-radius: 999px; display: inline-flex;
font-size: .72rem; font-weight: 750; padding: .35rem .7rem; white-space: nowrap; }
.count-badge { background: #dff3e7; color: #115d3a; }
.local-badge { background: #eef2ef; color: #55645b; }
.summary-badge { background: #e9eaff; color: #4c51a5; }
.meta-row { align-items: center; display: flex; flex-wrap: wrap; gap: .55rem; margin-top: 1rem; }
.meta-pill, .status-pill { border: 1px solid var(--line); border-radius: 999px; color: #536158;
font-size: .78rem; font-weight: 700; padding: .27rem .65rem; }
.status-pill { border: 0; }
.status-pending_review { background: #fff1cf; color: #76520b; }
.status-approved, .status-published { background: #dff3e7; color: #115d3a; }
.status-publishing { background: #e9eaff; color: #4c51a5; }
.status-rejected, .status-blocked { background: #fde6e4; color: #8c3030; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 18px;
box-shadow: 0 12px 36px rgba(27, 48, 36, .055); }
.queue-card, .empty-card, .attention-card, .queue-status, .message-card { margin: 0 auto 1.25rem; max-width: 920px;
padding: 1.6rem; width: calc(100% - 3rem); }
.queue-card h2, .empty-card h2 { font-size: 1.45rem; margin: .2rem 0 .6rem; }
.queue-card .button { margin-top: 1.35rem; }
.empty-card { padding: 3rem; text-align: center; }
.empty-icon { align-items: center; background: #dff3e7; border-radius: 999px; color: #167449;
display: inline-flex; font-size: 1.2rem; height: 2.6rem; justify-content: center; width: 2.6rem; }
.attention-card { border-color: #edc9c5; }
.attention-card ul { margin-bottom: 0; }
.attention-card span { color: var(--muted); }
.queue-status summary { cursor: pointer; font-weight: 750; }
.status-grid { display: grid; gap: .7rem; grid-template-columns: repeat(3, 1fr); margin-top: 1rem; }
.status-grid div { background: #f6f8f7; border-radius: 10px; padding: .7rem; }
.status-grid span { color: var(--muted); display: block; font-size: .72rem; }
.status-grid strong { font-size: 1.15rem; }
.review-grid { display: grid; gap: 1.4rem; grid-template-columns: minmax(0, 1fr) 360px;
margin: 0 auto; max-width: 1220px; padding: 0 1.5rem 4rem; width: 100%; }
.note-card { min-width: 0; padding: clamp(1.25rem, 3vw, 2.3rem); }
.review-sidebar { align-self: start; display: grid; gap: 1.2rem; position: sticky; top: 1.2rem; }
.preview-card, .action-card { padding: 1.15rem; }
.section-heading { align-items: center; border-bottom: 1px solid var(--line); display: flex;
justify-content: space-between; margin-bottom: 1.3rem; padding-bottom: 1rem; }
.section-heading h2, .action-card h2 { font-size: 1.25rem; margin: 0; }
.summary-block { background: #f6f8f7; border-left: 4px solid #8dc4a4; border-radius: 0 10px 10px 0;
color: #39483f; margin: 0 0 2rem; padding: 1rem 1.15rem; white-space: pre-wrap; }
.markdown-body { color: #2c3831; overflow-wrap: anywhere; }
.markdown-body > :first-child { margin-top: 0; }
.markdown-body h2, .markdown-body h3 { margin: 1.8rem 0 .8rem; }
.markdown-body pre { background: #f6f8f7; border-radius: 8px; overflow-x: auto; padding: 1rem; }
.markdown-body code { font: .9em/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
.markdown-body blockquote { border-left: 3px solid #8dc4a4; margin-left: 0; padding-left: 1rem; }
.markdown-body a { color: var(--accent-dark); }
.metadata-card { background: #f6f8f7; border: 1px solid var(--line); border-radius: 12px;
margin-bottom: 2rem; padding: .8rem 1rem; }
.metadata-card summary { cursor: pointer; font-weight: 750; }
.metadata-body { margin-top: 1rem; }
.discord-shell { background: var(--discord); border-radius: 12px; color: #dbdee1; display: flex;
font: 14px/1.4 "Segoe UI", sans-serif; gap: .7rem; padding: 1rem; }
.discord-avatar { align-items: center; background: #2d8b57; border-radius: 50%; color: white;
display: flex; flex: 0 0 38px; font-weight: 800; height: 38px; justify-content: center; width: 38px; }
.discord-message { min-width: 0; width: 100%; }
.discord-author { color: #f2f3f5; font-weight: 700; }
.discord-author span { background: #5865f2; border-radius: 3px; font-size: .58rem; margin-left: .3rem;
padding: .1rem .25rem; vertical-align: 2px; }
.discord-title { color: #f2f3f5; font-weight: 700; margin-top: .55rem; }
.discord-date { color: #949ba4; font-size: .78rem; margin: .08rem 0 .65rem; }
.discord-summary { background: #383a40; border: 1px solid #4e5058; border-radius: 6px;
color: #dbdee1; display: block; font: inherit; line-height: 1.45; margin-top: .3rem;
min-height: 8rem; padding: .65rem; resize: vertical; width: 100%; }
.discord-summary:focus { border-color: #80848e; outline: 2px solid #5865f2; outline-offset: 1px; }
.discord-editor-label { color: #b5bac1; display: block; font-size: .72rem; font-weight: 700;
margin-top: .65rem; }
.discord-editor-help { color: #949ba4; font-size: .72rem; margin: .45rem 0 0; }
.discord-summary-static { margin: .65rem 0 0; white-space: pre-wrap; }
.discord-doc-link { color: #00a8fc; font-weight: 600; margin-top: .7rem; }
.meeting-editor { border-top: 1px solid var(--line); margin-top: 2rem; padding-top: 1.5rem; }
.meeting-editor label { display: block; font-size: .82rem; font-weight: 750; }
.meeting-note-editor { background: #fbfcfb; border: 1px solid var(--line); border-radius: 9px;
color: var(--ink); display: block; font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo,
monospace; margin-top: .5rem; min-height: 24rem; padding: 1rem; resize: vertical; width: 100%; }
.meeting-note-editor:focus { border-color: var(--accent); outline: 2px solid #6db88d;
outline-offset: 1px; }
.editor-help, .privacy-note { color: var(--muted); font-size: .76rem; }
.actions { display: grid; gap: .6rem; margin-top: 1.1rem; }
.actions form { margin: 0; }
button, .button { border: 0; border-radius: 9px; cursor: pointer; display: inline-flex;
font: inherit; font-weight: 750; justify-content: center; padding: .72rem 1rem;
text-decoration: none; transition: .15s ease; }
.primary-button, .approve { background: var(--accent); color: white; width: 100%; }
.primary-button:hover, .approve:hover { background: var(--accent-dark); transform: translateY(-1px); }
.save-note { background: #e8f2ec; color: var(--accent-dark); margin-top: .6rem; width: 100%; }
.reject, .archive { background: #fff; border: 1px solid #e3c0bd; color: var(--danger); width: 100%; }
.reject:hover, .archive:hover { background: #fff4f3; }
button:focus-visible, .button:focus-visible, a:focus-visible { outline: 3px solid #6db88d;
outline-offset: 3px; }
.privacy-note { border-top: 1px solid var(--line); margin: 1rem 0 0; padding-top: .9rem; }
.logout { margin: 1.5rem auto 3rem; max-width: 920px; text-align: right; width: calc(100% - 3rem); }
.logout button { background: transparent; color: #456052; padding-right: 0; }
.message-card { margin-top: 4rem; }
@media (max-width: 880px) { .review-grid { grid-template-columns: 1fr; }
.review-sidebar { position: static; } }
@media (max-width: 600px) { .page-intro, .meeting-header { padding: 2rem 1rem 1.5rem; }
.back-link { padding: 0 1rem; } .review-grid { padding: 0 1rem 2rem; }
.queue-card, .empty-card, .attention-card, .queue-status, .message-card, .logout { width: calc(100% - 2rem); }
.intro-row { align-items: flex-start; flex-direction: column; gap: 1rem; }
.status-grid { grid-template-columns: repeat(2, 1fr); } .note-card { padding: 1.15rem; } }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important;
transition: none !important; } }
`;

const reviewStyleDigest = createHash("sha256").update(reviewStyles).digest("base64");

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title><style>${reviewStyles}</style></head><body>${body}</body></html>`;

const messagePage = (status: number) => {
	const [title, message] =
		status === 401
			? ["Unauthorized", "Use a fresh local review link."]
			: status === 403
				? ["Forbidden", "Reload the review page and try again."]
				: status === 404
					? ["Not found", "That review page is unavailable."]
					: status === 405
						? ["Method not allowed", "That request method is not supported."]
						: status === 413
							? ["Request too large", "The review form exceeded its local size limit."]
							: status === 409
								? ["Review changed", "Reload the item and review its current version."]
								: status === 400 || status === 411 || status === 415
									? ["Invalid request", "The local review request was rejected."]
									: ["Unavailable", "The local review service could not complete the request."];
	return page(
		title,
		`<section class="card message-card"><p class="eyebrow">Meeting publication</p><h1>${escapeHtml(title)}</h1>
<p>${message}</p><a class="button primary-button" href="/">Return to review</a></section>`,
	);
};

type ReviewReferrerPolicy = "no-referrer" | "same-origin";

// `no-referrer` makes native HTML POSTs send `Origin: null`; only canonical,
// query-free form pages opt into same-origin. Token redirects and errors do not.
const setSecurityHeaders = (response: ServerResponse, referrerPolicy: ReviewReferrerPolicy = "no-referrer") => {
	response.setHeader("Cache-Control", "no-store");
	response.setHeader(
		"Content-Security-Policy",
		`default-src 'none'; style-src 'sha256-${reviewStyleDigest}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
	);
	response.setHeader("Referrer-Policy", referrerPolicy);
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("X-Frame-Options", "DENY");
	response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
};

const send = (
	response: ServerResponse,
	status: number,
	body = "",
	head = false,
	referrerPolicy: ReviewReferrerPolicy = "no-referrer",
) => {
	if (response.headersSent || response.destroyed) return;
	const encoded = Buffer.from(body, "utf8");
	setSecurityHeaders(response, referrerPolicy);
	response.statusCode = status;
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.setHeader("Content-Length", String(encoded.byteLength));
	response.end(head ? undefined : encoded);
};

const redirect = (response: ServerResponse, location: string, cookie?: string) => {
	setSecurityHeaders(response);
	response.statusCode = 303;
	response.setHeader("Location", location);
	response.setHeader("Content-Length", "0");
	if (cookie !== undefined) response.setHeader("Set-Cookie", cookie);
	response.end();
};

const validPercentEncoding = (value: string) => !/%(?![0-9a-f]{2})/iu.test(value);

const exactHeader = (request: IncomingMessage, name: string) => {
	const positions: Array<string> = [];
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		if (request.rawHeaders[index]?.toLowerCase() === name) positions.push(request.rawHeaders[index + 1] ?? "");
	}
	return positions.length === 1 ? positions[0] : null;
};

const cookieSessionId = (request: IncomingMessage) => {
	const raw = request.headers.cookie;
	if (raw === undefined) return null;
	const values = raw
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${cookieName}=`))
		.map((part) => part.slice(cookieName.length + 1));
	return values.length === 1 && tokenPattern.test(values[0] ?? "") ? (values[0] ?? null) : null;
};

const readBody = async (request: IncomingMessage, limit: number) => {
	const lengthHeader = exactHeader(request, "content-length");
	if (lengthHeader === null || !/^\d+$/u.test(lengthHeader)) throw new ReviewHttpError(411, "length");
	const expected = Number(lengthHeader);
	if (!Number.isSafeInteger(expected) || expected > limit) throw new ReviewHttpError(413, "size");
	const chunks: Array<Buffer> = [];
	let received = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		received += bytes.byteLength;
		if (received <= limit) chunks.push(bytes);
	}
	if (received !== expected || received > limit) throw new ReviewHttpError(received > limit ? 413 : 400, "body");
	const body = Buffer.concat(chunks);
	if (!isUtf8(body)) throw new ReviewHttpError(400, "encoding");
	const text = body.toString("utf8");
	if (!validPercentEncoding(text)) throw new ReviewHttpError(400, "encoding");
	return text;
};

const decodeFormComponent = (encoded: string) => {
	const bytes: Array<number> = [];
	for (let index = 0; index < encoded.length; ) {
		const character = encoded[index];
		if (character === "+") {
			bytes.push(0x20);
			index += 1;
			continue;
		}
		if (character === "%") {
			const pair = encoded.slice(index + 1, index + 3);
			if (!/^[0-9a-f]{2}$/iu.test(pair)) throw new ReviewHttpError(400, "encoding");
			bytes.push(Number.parseInt(pair, 16));
			index += 3;
			continue;
		}
		const codePoint = encoded.codePointAt(index);
		if (codePoint === undefined) throw new ReviewHttpError(400, "encoding");
		bytes.push(...Buffer.from(String.fromCodePoint(codePoint), "utf8"));
		index += codePoint > 0xffff ? 2 : 1;
	}
	const decoded = Buffer.from(bytes);
	if (!isUtf8(decoded)) throw new ReviewHttpError(400, "encoding");
	return decoded.toString("utf8");
};

const parseForm = (body: string, allowed: ReadonlyArray<string>) => {
	const values = new Map<string, Array<string>>();
	for (const field of body.split("&")) {
		if (field.length === 0) continue;
		const separator = field.indexOf("=");
		const key = decodeFormComponent(separator < 0 ? field : field.slice(0, separator));
		const value = decodeFormComponent(separator < 0 ? "" : field.slice(separator + 1));
		if (!allowed.includes(key)) throw new ReviewHttpError(400, "field");
		const found = values.get(key) ?? [];
		found.push(value);
		values.set(key, found);
	}
	const result: Record<string, string> = {};
	for (const key of allowed) {
		const found = values.get(key) ?? [];
		if (found.length !== 1) throw new ReviewHttpError(400, "field");
		result[key] = found[0] ?? "";
	}
	return result;
};

const logoutForm = (csrf: string) =>
	`<form class="logout" method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Log out</button></form>`;

const statusLabel = (status: string) =>
	status
		.split("_")
		.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join(" ");

const statusClass = (status: string) =>
	(["pending_review", "approved", "publishing", "published", "rejected", "blocked"] as ReadonlyArray<string>).includes(
		status,
	)
		? status
		: "unknown";

const failureStageNames: ReadonlySet<string> = new Set(MeetingPublicationFailureStage.literals);
const failureCodePattern = /^sha256:[a-f0-9]{24}$/u;

export interface MeetingPublicationReviewDispatch {
	readonly maxItems: number;
}

const preflightForm = (csrf: string, mode: MeetingPublicationReviewMode) =>
	mode === "decision_only"
		? ""
		: `<section class="card queue-card"><p class="section-label">Publication readiness</p>
<h2>Check configured destinations</h2><p class="lede">Verify the current source notes, Google owner, and Discord channel without publishing.</p>
<form method="post" action="/preflight"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button class="button primary-button" type="submit">Check publication readiness</button></form></section>`;

const preflightFieldPattern = /^[a-z][a-z0-9_:-]{0,127}$/u;

const renderPreflightResult = (result: MeetingPublicationPreflightResult) =>
	page(
		"Meeting publication readiness",
		`<section class="card message-card"><p class="eyebrow">Meeting publication</p>
<h1>${result.ready ? "Ready to publish" : "Publication is not ready"}</h1>
<p>${result.ready ? "All required checks passed." : "One or more required checks failed."} No meeting was approved or published.</p>
<div class="status-grid">${result.checks
			.map((check) => {
				const name = preflightFieldPattern.test(check.name) ? statusLabel(check.name) : "Check unavailable";
				const code = preflightFieldPattern.test(check.code) ? check.code : "unavailable";
				return `<div><span>${escapeHtml(name)}</span><strong>${check.passed ? "Pass" : check.required ? "Fail" : "Warning"}</strong><code>${escapeHtml(code)}</code></div>`;
			})
			.join("")}</div>
<a class="button primary-button" href="/">Return to review</a></section>`,
	);

const dispatchForm = (csrf: string, dispatch: MeetingPublicationReviewDispatch | undefined) =>
	dispatch === undefined
		? ""
		: `<section class="card queue-card"><p class="section-label">Manual dispatch</p>
<h2>Publish approved meetings</h2><p class="lede">Run one bounded local dispatch for up to ${dispatch.maxItems} approved meeting${dispatch.maxItems === 1 ? "" : "s"}.</p>
<form method="post" action="/dispatch"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button class="button primary-button" type="submit">Dispatch approved meetings</button></form></section>`;

const renderDispatchResult = (result: {
	readonly scanned: number;
	readonly published: number;
	readonly failed: number;
	readonly pendingReview: number;
}) =>
	page(
		"Meeting dispatch result",
		`<section class="card message-card"><p class="eyebrow">Meeting publication</p><h1>Dispatch run finished</h1>
<p>The bounded dispatch run completed. Queued work may remain.</p><div class="status-grid">
<div><span>Source notes scanned</span><strong>${result.scanned}</strong></div>
<div><span>Published</span><strong>${result.published}</strong></div>
<div><span>Failed</span><strong>${result.failed}</strong></div>
<div><span>Waiting for review</span><strong>${result.pendingReview}</strong></div></div>
<a class="button primary-button" href="/">Return to review</a></section>`,
	);

const renderInbox = (
	items: ReadonlyArray<MeetingPublicationItem>,
	csrf: string,
	nextMeeting: { readonly itemId: string; readonly title: string | null } | null,
	mode: MeetingPublicationReviewMode,
	dispatch: MeetingPublicationReviewDispatch | undefined,
) => {
	const reviewItems = items.filter((item) => item.status === "pending_review" || item.status === "blocked");
	const attentionItems = items.filter(
		(item) => item.status === "blocked" || (item.status === "approved" && item.failureStage !== null),
	);
	const header = `<header class="page-intro"><div class="intro-row"><div><p class="eyebrow">Local publication queue</p>
<h1>Meeting review</h1><p class="lede">Review decisions and local dispatch status are shown below.</p></div>
${reviewItems.length > 0 ? `<span class="count-badge">${reviewItems.length} in queue</span>` : ""}</div></header>`;
	const queue =
		reviewItems.length === 0
			? attentionItems.length === 0
				? `<section class="card empty-card"><span class="empty-icon" aria-hidden="true">✓</span>
<h2>No meetings are waiting for review</h2><p class="lede">See queue status below for dispatch progress.</p></section>`
				: `<section class="card empty-card"><h2>No review decisions are waiting</h2>
<p class="lede">Local dispatch still needs attention below.</p></section>`
			: reviewItems
					.map(
						(item) =>
							`<section class="card queue-card"><p class="section-label">Meeting note</p>
<h2>${nextMeeting?.itemId === item.itemId ? (nextMeeting.title === null ? "Meeting title unavailable" : safeReviewText(nextMeeting.title)) : `Meeting · ${escapeHtml(item.meetingDate)}`}</h2><div class="meta-row">
<span class="meta-pill">${escapeHtml(item.meetingDate)}</span>
<span class="status-pill status-${statusClass(item.status)}">${escapeHtml(statusLabel(item.status))}</span></div>
<a class="button primary-button" href="/item/${item.itemId}">Review meeting</a></section>`,
					)
					.join("");
	const attention =
		attentionItems.length === 0
			? ""
			: `<section class="card attention-card"><p class="section-label">Dispatch needs attention</p>
<ul>${attentionItems
					.map((item) => {
						const stage =
							item.failureStage !== null && failureStageNames.has(item.failureStage)
								? `${escapeHtml(statusLabel(item.failureStage))} stage`
								: "Stage unavailable";
						const diagnostic =
							item.failureCode !== null && failureCodePattern.test(item.failureCode)
								? `Diagnostic ${escapeHtml(item.failureCode)}`
								: "Diagnostic unavailable";
						return `<li><strong>${item.status === "blocked" ? "Blocked" : "Retry scheduled"}</strong> · ${escapeHtml(item.meetingDate)}<br><span>${stage}</span><details><summary>Technical details</summary><code>${diagnostic}</code></details></li>`;
					})
					.join("")}</ul></section>`;
	const counts = `<details class="card queue-status"><summary>Queue status</summary><div class="status-grid">${MeetingPublicationStatus.literals
		.map((status) => {
			const count = items.filter((item) => item.status === status).length;
			return `<div><span>${escapeHtml(statusLabel(status))}</span><strong>${count}</strong></div>`;
		})
		.join("")}</div></details>`;
	return page(
		"Meeting publication review",
		`${header}${queue}${attention}${counts}${preflightForm(csrf, mode)}${dispatchForm(csrf, dispatch)}${logoutForm(csrf)}`,
	);
};

const renderItem = (
	item: { readonly itemId: string; readonly sourceHash: string; readonly status: string },
	note: { readonly title: string; readonly meetingDate: string; readonly summary: string; readonly markdown: string },
	purpose: string,
	csrf: string,
	mode: MeetingPublicationReviewMode,
) => {
	const hidden = `<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="item_id" value="${item.itemId}">
<input type="hidden" name="source_hash" value="${item.sourceHash}">`;
	const noteEditor =
		mode === "full" && item.status === "pending_review"
			? `<form method="post" action="/update-note/${item.itemId}" class="meeting-editor">${hidden}
<label for="meeting-markdown">Edit canonical note Markdown</label>
<textarea class="meeting-note-editor" id="meeting-markdown" name="meeting_markdown" data-max-code-points="${MEETING_PUBLICATION_NOTE_MAX_LENGTH}" aria-describedby="meeting-markdown-limit" required spellcheck="true">${escapeHtml(note.markdown)}</textarea>
<p class="editor-help" id="meeting-markdown-limit">Maximum ${MEETING_PUBLICATION_NOTE_MAX_LENGTH} Unicode characters; checked when submitted.</p>
<button class="save-note" type="submit">Update meeting note</button></form>
<p class="privacy-note">Updating writes the canonical local Markdown and keeps this meeting unapproved.</p>`
			: "";
	const purposePreview =
		item.status === "pending_review" || item.status === "blocked"
			? `<label class="discord-editor-label" for="purpose">Discord purpose</label>
<textarea class="discord-summary" id="purpose" name="purpose" form="approve-form" maxlength="${MEETING_PUBLICATION_PURPOSE_MAX_LENGTH}" required aria-describedby="purpose-help">${escapeHtml(purpose)}</textarea>
<p class="discord-editor-help" id="purpose-help">Keep this to one short sentence. It does not alter the meeting note.</p>`
			: `<p class="discord-summary-static">${safeReviewText(purpose)}</p>`;
	const actions =
		item.status === "pending_review" || item.status === "blocked"
			? `<section class="card action-card"><p class="section-label">Decision</p><h2>Ready to publish?</h2>
<p class="lede">Approval applies only to this exact version of the note.</p><div class="actions">
<form id="approve-form" method="post" action="/approve/${item.itemId}">${hidden}<button class="approve" type="submit">Approve for publication</button></form>
${item.status === "pending_review" ? `<form method="post" action="/reject/${item.itemId}">${hidden}<button class="reject" type="submit">Reject</button></form>` : ""}
<form method="post" action="/archive/${item.itemId}">${hidden}<button class="archive" type="submit">Archive</button></form>
</div><p class="privacy-note">These actions update only the local publication queue.</p></section>`
			: `<section class="card action-card"><p class="section-label">Decision</p>
<h2>${escapeHtml(statusLabel(item.status))}</h2><p class="lede">This meeting is no longer awaiting review.</p></section>`;
	return page(
		note.title,
		`<a class="back-link" href="/"><span aria-hidden="true">←</span> Review inbox</a>
<header class="meeting-header"><p class="eyebrow">Meeting publication · Local review</p>
<h1>${escapeHtml(note.title)}</h1><div class="meta-row"><span class="meta-pill">${escapeHtml(note.meetingDate)}</span>
<span class="status-pill status-${statusClass(item.status)}">${escapeHtml(statusLabel(item.status))}</span></div></header>
<div class="review-grid"><main class="card note-card"><div class="section-heading">
<div><p class="section-label">Canonical source</p><h2>Meeting note</h2></div><span class="local-badge">Local Markdown</span></div>
<h3>Executive Summary</h3><div class="summary-block markdown-body">${renderMeetingPublicationReviewMarkdown(note.summary)}</div>
<h3>Canonical note</h3><article class="canonical-markdown markdown-body">${renderMeetingPublicationReviewNote(note.markdown)}</article>${noteEditor}</main>
<aside class="review-sidebar"><section class="card preview-card"><div class="section-heading">
<div><p class="section-label">Destination preview</p><h2>Discord</h2></div><span class="summary-badge">Purpose only</span></div>
<div class="discord-shell"><div class="discord-avatar" aria-hidden="true">M</div><div class="discord-message">
<div class="discord-author">Meeting publication <span>PREVIEW</span></div>
<div class="discord-title">${escapeHtml(note.title)}</div><div class="discord-date">${escapeHtml(note.meetingDate)}</div>
${purposePreview}
<div class="discord-doc-link">↗ Read the full meeting notes</div></div></div></section>${actions}</aside></div>${logoutForm(csrf)}`,
	);
};

const closeServer = (server: Server) =>
	Effect.promise(
		() =>
			new Promise<void>((resolveClose) => {
				server.close(() => resolveClose());
				server.closeAllConnections();
			}),
	);

/** Scoped, loopback-only HTTP review boundary with in-memory session state. */
export class MeetingPublicationReviewServer extends Context.Service<
	MeetingPublicationReviewServer,
	{ readonly address: MeetingPublicationReviewAddress }
>()("@harnessy/core/MeetingPublicationReviewServer") {
	static layer(
		config: JarvisMeetingPublicationConfig,
		mode: MeetingPublicationReviewMode = "full",
		dispatch?: MeetingPublicationReviewDispatch,
	) {
		const boundedDispatch = dispatch === undefined ? undefined : Object.freeze({ maxItems: dispatch.maxItems });
		return Layer.effect(
			MeetingPublicationReviewServer,
			Effect.gen(function* () {
				const authorityService = yield* MeetingPublicationWriteAuthority;
				const binding = yield* resolveMeetingPublicationWriteBinding(config, "review_serve");
				yield* authorizeMeetingPublicationWrite(authorityService, "review_serve", binding);
				if (
					(mode !== "full" && mode !== "decision_only") ||
					!(["127.0.0.1", "::1"] as ReadonlyArray<string>).includes(config.reviewHost) ||
					!Number.isInteger(config.reviewPort) ||
					config.reviewPort < 0 ||
					config.reviewPort > 65_535 ||
					!Number.isInteger(config.reviewSessionSeconds) ||
					config.reviewSessionSeconds < 60 ||
					config.reviewSessionSeconds > 86_400 ||
					!Number.isInteger(config.reviewMaxSessions) ||
					config.reviewMaxSessions < 1 ||
					config.reviewMaxSessions > 1_024 ||
					!Number.isInteger(config.reviewMaxBodyBytes) ||
					config.reviewMaxBodyBytes < 256 ||
					config.reviewMaxBodyBytes > JARVIS_MEETING_PUBLICATION_REVIEW_MAX_BODY_BYTES ||
					(boundedDispatch !== undefined &&
						(mode !== "full" ||
							!Number.isSafeInteger(boundedDispatch.maxItems) ||
							boundedDispatch.maxItems < 1 ||
							boundedDispatch.maxItems > 100))
				) {
					return yield* new MeetingPublicationReviewError({ code: "invalid_config" });
				}
				const store = yield* MeetingPublicationStore;
				const source = yield* MeetingPublicationSource;
				const publication = yield* MeetingPublicationService;
				const clock = yield* MeetingPublicationClock;
				const randomSource = yield* MeetingPublicationReviewRandom;
				const seenRandomValues = new Set<string>();
				const random = MeetingPublicationReviewRandom.of({
					bytes: (length) =>
						randomSource.bytes(length).pipe(
							Effect.flatMap((bytes) =>
								Effect.try({
									try: () => {
										if (bytes.byteLength !== length) {
											throw new MeetingPublicationReviewError({ code: "server_failed" });
										}
										const digest = createHash("sha256").update(bytes).digest("hex");
										if (seenRandomValues.has(digest)) {
											throw new MeetingPublicationReviewError({ code: "server_failed" });
										}
										seenRandomValues.add(digest);
										return bytes;
									},
									catch: () => new MeetingPublicationReviewError({ code: "server_failed" }),
								}),
							),
						),
				});
				const stateRoot = dirname(store.dbPath);
				const bootstrapToken = yield* loadOrCreateToken(stateRoot, random);
				const sessions = new Map<string, ReviewSession>();
				const requestController = new AbortController();
				const activeHandlers = new Set<Promise<void>>();
				let randomCounter = 0;
				let authority = "";
				let origin = "";
				let mutationInFlight = false;

				const runRequestEffect = <A, E>(effect: Effect.Effect<A, E>) =>
					Effect.runPromise(effect, { signal: requestController.signal });
				const now = () => runRequestEffect(clock.now);
				const randomValue = async (kind: "session" | "csrf") => {
					const bytes = await runRequestEffect(random.bytes(32));
					return encodeRandom(deriveRandom(bytes, `${kind}:${randomCounter++}`), 32);
				};
				const purgeSessions = (current: number) => {
					for (const [id, session] of sessions) if (session.expiresAt <= current) sessions.delete(id);
				};
				const sessionFor = async (request: IncomingMessage) => {
					const current = await now();
					purgeSessions(current);
					const supplied = cookieSessionId(request);
					if (supplied === null) return null;
					for (const [id, session] of sessions) if (secureEqual(id, supplied)) return { id, session };
					return null;
				};
				const authorizeRequest = async () => {
					await runRequestEffect(
						authorizeMeetingPublicationWrite(authorityService, "review_serve", binding),
					).catch(() => {
						sessions.clear();
						throw new ReviewHttpError(503, "authorization");
					});
				};
				const runMutation = async <A>(mutation: () => Promise<A>) => {
					if (mutationInFlight) throw new ReviewHttpError(409, "mutation_in_flight");
					mutationInFlight = true;
					try {
						return await mutation();
					} finally {
						mutationInFlight = false;
					}
				};

				const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
					await authorizeRequest();
					const requestHost = exactHeader(request, "host");
					if (requestHost === null || requestHost !== authority) throw new ReviewHttpError(400, "host");
					if (request.url === undefined || !request.url.startsWith("/") || request.url.startsWith("//")) {
						throw new ReviewHttpError(400, "target");
					}
					const url = new URL(request.url, origin);
					const head = request.method === "HEAD";
					if (request.method === "GET" && url.pathname === "/exchange") {
						if (
							!validPercentEncoding(url.search) ||
							[...new Set(url.searchParams.keys())].some((key) => key !== "token")
						) {
							throw new ReviewHttpError(400, "query");
						}
						const tokens = url.searchParams.getAll("token");
						if (tokens.length !== 1 || !secureEqual(tokens[0] ?? "", bootstrapToken)) {
							throw new ReviewHttpError(401, "token");
						}
						const current = await now();
						purgeSessions(current);
						while (sessions.size >= config.reviewMaxSessions) {
							const oldest = [...sessions].sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
							if (oldest === undefined) break;
							sessions.delete(oldest[0]);
						}
						let sessionId = "";
						let csrf = "";
						for (let attempt = 0; attempt < 8; attempt += 1) {
							sessionId = await randomValue("session");
							if (!secureEqual(sessionId, bootstrapToken) && !sessions.has(sessionId)) break;
							sessionId = "";
						}
						if (sessionId.length === 0) throw new ReviewHttpError(500, "random");
						for (let attempt = 0; attempt < 8; attempt += 1) {
							csrf = await randomValue("csrf");
							if (
								!secureEqual(csrf, bootstrapToken) &&
								!secureEqual(csrf, sessionId) &&
								![...sessions.values()].some((session) => secureEqual(session.csrf, csrf))
							) {
								break;
							}
							csrf = "";
						}
						if (csrf.length === 0) throw new ReviewHttpError(500, "random");
						sessions.set(sessionId, {
							csrf,
							createdAt: current,
							expiresAt: current + config.reviewSessionSeconds * 1_000,
						});
						redirect(
							response,
							"/",
							`${cookieName}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.reviewSessionSeconds}`,
						);
						return;
					}
					if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
						response.setHeader("Allow", "GET, HEAD, POST");
						throw new ReviewHttpError(405, "method");
					}
					const authenticated = await sessionFor(request);
					if (authenticated === null) throw new ReviewHttpError(401, "session");

					if (request.method === "GET" || request.method === "HEAD") {
						if (url.search.length > 0) throw new ReviewHttpError(400, "query");
						if (url.pathname === "/") {
							const items = await runRequestEffect(store.list());
							const next = items.find((item) => item.status === "pending_review");
							const note =
								next === undefined
									? null
									: await runRequestEffect(source.read(next.notePath)).catch(() => null);
							const nextMeeting =
								next === undefined
									? null
									: {
											itemId: next.itemId,
											title:
												note !== null && note.itemId === next.itemId && note.sourceHash === next.sourceHash
													? note.title
													: null,
										};
							send(
								response,
								200,
								renderInbox(items, authenticated.session.csrf, nextMeeting, mode, boundedDispatch),
								head,
								"same-origin",
							);
							return;
						}
						const match = /^\/item\/([a-f0-9]{24})$/u.exec(url.pathname);
						if (match?.[1] === undefined) throw new ReviewHttpError(404, "route");
						const item = await runRequestEffect(store.get(match[1]));
						if (item === null) throw new ReviewHttpError(404, "item");
						const note = await runRequestEffect(source.read(item.notePath)).catch(() => null);
						if (note === null || note.sourceHash !== item.sourceHash) throw new ReviewHttpError(409, "changed");
						const purpose = item.discordPurposeOverride ?? meetingPublicationDefaultPurpose(note);
						send(
							response,
							200,
							renderItem(item, note, purpose, authenticated.session.csrf, mode),
							head,
							"same-origin",
						);
						return;
					}

					if (exactHeader(request, "origin") !== origin) throw new ReviewHttpError(403, "origin");
					const contentType = exactHeader(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
					if (contentType !== formContentType) throw new ReviewHttpError(415, "content-type");
					if (mode === "decision_only" && /^\/(?:update-note|restore)\/[a-f0-9]{24}$/u.test(url.pathname)) {
						throw new ReviewHttpError(404, "route");
					}
					if (url.pathname === "/logout") {
						const body = await readBody(request, config.reviewMaxBodyBytes);
						const form = parseForm(body, ["csrf"]);
						if (!secureEqual(form.csrf ?? "", authenticated.session.csrf)) {
							throw new ReviewHttpError(403, "csrf");
						}
						sessions.delete(authenticated.id);
						redirect(response, "/", `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
						return;
					}
					if (url.pathname === "/preflight") {
						if (mode !== "full") throw new ReviewHttpError(404, "route");
						const result = await runMutation(async () => {
							const body = await readBody(request, config.reviewMaxBodyBytes);
							const form = parseForm(body, ["csrf"]);
							if (!secureEqual(form.csrf ?? "", authenticated.session.csrf)) {
								throw new ReviewHttpError(403, "csrf");
							}
							return runRequestEffect(publication.preflight());
						});
						send(response, 200, renderPreflightResult(result), false, "same-origin");
						return;
					}
					if (url.pathname === "/dispatch") {
						if (boundedDispatch === undefined) throw new ReviewHttpError(404, "route");
						const result = await runMutation(async () => {
							const body = await readBody(request, config.reviewMaxBodyBytes);
							const form = parseForm(body, ["csrf"]);
							if (!secureEqual(form.csrf ?? "", authenticated.session.csrf)) {
								throw new ReviewHttpError(403, "csrf");
							}
							return runRequestEffect(publication.worker(boundedDispatch.maxItems));
						});
						send(response, 200, renderDispatchResult(result), false, "same-origin");
						return;
					}
					const action = /^\/(update-note|approve|reject|archive)\/([a-f0-9]{24})$/u.exec(url.pathname);
					if (action?.[1] === undefined || action[2] === undefined) throw new ReviewHttpError(404, "route");
					const item = await runMutation(async () => {
						const body = await readBody(request, config.reviewMaxBodyBytes);
						let allowed: ReadonlyArray<string>;
						if (action[1] === "approve") allowed = ["csrf", "item_id", "source_hash", "purpose"];
						else if (action[1] === "update-note") {
							allowed = ["csrf", "item_id", "source_hash", "meeting_markdown"];
						} else allowed = ["csrf", "item_id", "source_hash"];
						const form = parseForm(body, allowed);
						if (!secureEqual(form.csrf ?? "", authenticated.session.csrf)) {
							throw new ReviewHttpError(403, "csrf");
						}
						if (
							!itemIdPattern.test(form.item_id ?? "") ||
							!hashPattern.test(form.source_hash ?? "") ||
							!secureEqual(form.item_id ?? "", action[2])
						) {
							throw new ReviewHttpError(409, "item");
						}
						const item = await runRequestEffect(store.get(action[2]));
						if (item === null) throw new ReviewHttpError(404, "item");
						const accepted = await (async () => {
							if (action[1] === "update-note") {
								await runRequestEffect(
									publication.updateNote(item.itemId, form.source_hash ?? "", form.meeting_markdown ?? ""),
								);
							} else if (action[1] === "approve") {
								await runRequestEffect(publication.approve(item.itemId, form.source_hash ?? "", form.purpose));
							} else if (action[1] === "reject") {
								await runRequestEffect(publication.reject(item.itemId, form.source_hash));
							} else {
								await runRequestEffect(publication.archive(item.itemId, form.source_hash));
							}
						})().then(
							() => true,
							() => false,
						);
						if (!accepted) throw new ReviewHttpError(409, "conflict");
						return item;
					});
					redirect(response, action[1] === "update-note" ? `/item/${item.itemId}` : "/");
				};
				const handler = async (request: IncomingMessage, response: ServerResponse) => {
					const failure = await handleRequest(request, response).then(
						() => null,
						(cause: unknown) => cause,
					);
					if (failure !== null) {
						const status = failure instanceof ReviewHttpError ? failure.status : 500;
						send(response, status, messagePage(status), request.method === "HEAD");
					}
				};

				const server = createServer(
					{
						headersTimeout: 5_000,
						requestTimeout: 5_000,
						keepAliveTimeout: 1_000,
						maxHeaderSize: 8_192,
					},
					(request, response) => {
						const active = handler(request, response);
						activeHandlers.add(active);
						void active.then(
							() => activeHandlers.delete(active),
							() => activeHandlers.delete(active),
						);
					},
				);
				server.maxRequestsPerSocket = 100;
				const listening = yield* Effect.acquireRelease(
					Effect.tryPromise({
						try: () =>
							new Promise<Server>((resolveListen, rejectListen) => {
								server.once("error", rejectListen);
								server.listen({ host: config.reviewHost, port: config.reviewPort, exclusive: true }, () => {
									server.off("error", rejectListen);
									resolveListen(server);
								});
							}),
						catch: () => new MeetingPublicationReviewError({ code: "server_failed" }),
					}),
					(resource) =>
						Effect.sync(() => requestController.abort()).pipe(
							Effect.andThen(closeServer(resource)),
							Effect.andThen(
								Effect.promise(async () => {
									await Promise.allSettled(activeHandlers);
								}),
							),
							Effect.ensuring(
								Effect.sync(() => {
									sessions.clear();
									const rendezvous = resolve(stateRoot, meetingPublicationReviewRendezvousFileName);
									if (existsSync(rendezvous)) unlinkSync(rendezvous);
								}),
							),
						),
				);
				const address = listening.address();
				if (address === null || typeof address === "string") {
					return yield* new MeetingPublicationReviewError({ code: "server_failed" });
				}
				const port = (address as AddressInfo).port;
				authority = config.reviewHost === "::1" ? `[::1]:${port}` : `127.0.0.1:${port}`;
				origin = `http://${authority}`;
				if (port !== 0) publishRendezvous(stateRoot, origin, port);
				return MeetingPublicationReviewServer.of({
					address: new MeetingPublicationReviewAddress({ host: config.reviewHost, port, origin }),
				});
			}),
		);
	}
}
