import { headerText, MIN_SECRET_LENGTH } from "./sanitize.ts";

/** The subset of `fetch` the remote senders use; tests pass a fake. */
export type Fetch = (
	url: string,
	init: {
		readonly method: "POST";
		readonly headers: Readonly<Record<string, string>>;
		readonly body: string;
		readonly signal: AbortSignal;
		readonly redirect: "error";
	},
) => Promise<{ readonly status: number }>;

/** A sanitized notification, ready to leave the machine. */
export interface OutgoingNotification {
	readonly event: string;
	readonly title: string;
	readonly message: string;
	readonly nextStep: string;
	/** True for events that need the person to act; ntfy shows these with high priority. */
	readonly needsYou: boolean;
}

/** Wait before the single retry of a failed remote send. */
export const RETRY_DELAY_MS = 500;

/**
 * True for an `https:` URL, or an `http:` URL whose host is this machine.
 * URLs with a user name or password are refused: a token belongs in the
 * header setting, never inside a URL that could be logged.
 */
export const allowedPushUrl = (value: string): boolean => {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	if (url.username !== "" || url.password !== "") return false;
	return (
		url.protocol === "https:" ||
		(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
	);
};

/**
 * A token must be one visible ASCII word, so it cannot inject another header,
 * and long enough that the sanitiser redacts it wherever it appears.
 */
export const allowedToken = (value: string): boolean =>
	/^[!-~]{1,512}$/u.test(value) && value.length >= MIN_SECRET_LENGTH;

export interface SendResult {
	readonly ok: boolean;
	/** Fixed text: an HTTP status or a failure class, never the URL, the token or a response body. */
	readonly detail: string;
}

/**
 * POST once, and retry once after `RETRY_DELAY_MS` on a network error, a
 * timeout, HTTP 429 or a 5xx. Other statuses are final. Each attempt is
 * bounded by `timeoutMs`.
 */
export const postWithRetry = async (
	fetch: Fetch,
	sleep: (ms: number) => Promise<void>,
	url: string,
	headers: Readonly<Record<string, string>>,
	body: string,
	timeoutMs: number,
): Promise<SendResult> => {
	const attempt = (): Promise<SendResult & { readonly retry: boolean }> =>
		Promise.resolve()
			.then(() =>
				fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: "error" }),
			)
			.then(
				(response) => ({
					ok: response.status >= 200 && response.status < 300,
					detail: `HTTP ${response.status}`,
					retry: response.status === 429 || response.status >= 500,
				}),
				(error: unknown) => ({
					ok: false,
					detail:
						error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
							? "timed out"
							: "network error",
					retry: true,
				}),
			);
	const first = await attempt();
	if (first.ok || !first.retry) return { ok: first.ok, detail: first.detail };
	await sleep(RETRY_DELAY_MS);
	const second = await attempt();
	return { ok: second.ok, detail: second.detail };
};

/**
 * ntfy publish: the message (with its next step) is the body; title,
 * priority and tags go in headers; the access token, when set, only in the
 * `Authorization` header.
 */
export const ntfyRequest = (
	notification: OutgoingNotification,
	token: string | undefined,
): { readonly headers: Readonly<Record<string, string>>; readonly body: string } => ({
	headers: {
		"Content-Type": "text/plain; charset=utf-8",
		Title: headerText(`Harnessy: ${notification.title}`),
		Priority: notification.needsYou ? "high" : "default",
		Tags: headerText(`harnessy,${notification.event}`),
		...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
	},
	body:
		notification.nextStep === "" ? notification.message : `${notification.message}\nNext: ${notification.nextStep}`,
});

/** Generic webhook: one JSON object with exactly these fields. */
export const webhookRequest = (
	notification: OutgoingNotification,
	now: number,
): { readonly headers: Readonly<Record<string, string>>; readonly body: string } => ({
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		event: notification.event,
		title: notification.title,
		message: notification.message,
		next_step: notification.nextStep,
		ts: new Date(now).toISOString(),
	}),
});
