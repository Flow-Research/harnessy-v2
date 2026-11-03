import { useEffect, useRef, useState } from "react";
import type { SessionClient } from "../lib/session.ts";

export const BrowserSignIn = ({ client, onSignedIn }: { client: SessionClient; onSignedIn: () => void }) => {
	const [pending, setPending] = useState<{ id: string; claim: string }>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const active = useRef(true);
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	useEffect(() => {
		if (!pending) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		const deadline = Date.now() + 60000;
		const poll = async () => {
			try {
				if (Date.now() >= deadline) throw new Error("Sign-in expired. Try again and allow Harnessy to open.");
				const signedIn = await client.claimBrowserSignIn(pending.id, pending.claim);
				if (cancelled) return;
				if (signedIn) onSignedIn();
				else timer = setTimeout(() => void poll(), 500);
			} catch (failure) {
				if (!cancelled) {
					setError(failure instanceof Error ? failure.message : "Could not sign in. Try again.");
					setPending(undefined);
				}
			}
		};
		void poll();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [pending, client, onSignedIn]);
	return (
		<>
			<button
				type="button"
				className="button button-primary"
				disabled={busy || Boolean(pending)}
				onClick={() => {
					setBusy(true);
					setError("");
					void client
						.beginBrowserSignIn()
						.then((request) => {
							if (!active.current) return;
							setPending(request);
							window.location.assign(`harnessy://signin/${request.id}`);
						})
						.catch(() => {
							if (active.current) setError("Could not start sign-in. Try again shortly.");
						})
						.finally(() => {
							if (active.current) setBusy(false);
						});
				}}
			>
				{pending ? "Waiting for Harnessy…" : "Sign in with Harnessy app"}
			</button>
			{pending ? <output>Allow Harnessy to open. Sign-in will finish in this tab.</output> : null}
			{error ? <p role="alert">{error}</p> : null}
		</>
	);
};
