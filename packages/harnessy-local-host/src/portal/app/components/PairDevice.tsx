import { useEffect, useState } from "react";
import type { SessionClient } from "../lib/session.ts";

export const PairDevice = ({ client }: { client: SessionClient }) => {
	const [devices, setDevices] = useState<{ id: string; name: string }[]>([]);
	const [origin, setOrigin] = useState("");
	const [name, setName] = useState("My phone");
	const [url, setUrl] = useState("");
	const [error, setError] = useState("");
	useEffect(() => {
		void client.get("/v1/terminal/sessions").then((result) => {
			if (result.kind !== "ok") return;
			const body = result.body as { remoteOrigin?: string; devices?: { id: string; name: string }[] };
			setOrigin(body.remoteOrigin ?? "");
			setDevices(body.devices ?? []);
		});
	}, [client]);
	return (
		<section className="pair-device" aria-labelledby="pair-device-title">
			<h3 id="pair-device-title">Connect a device</h3>
			<p className="text-2">
				Open a one-time link on your device. It grants access to your workspace and terminals for 30 days, unless
				revoked here.
			</p>
			{origin ? (
				<>
					<label className="field">
						Device name
						<input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
					</label>
					<button
						type="button"
						className="button"
						onClick={() => {
							void client.terminalAction({ action: "pair-device", name }).then((result) => {
								if (result.kind === "ok") {
									setUrl((result.body as { url: string }).url);
									setError("");
								} else setError(result.kind === "error" ? result.message : "Sign in on the host first.");
							});
						}}
					>
						Create one-time pairing link
					</button>
					{url ? (
						<label className="field">
							Open on your device within 60 seconds
							<input className="input mono" readOnly value={url} onFocus={(e) => e.target.select()} />
						</label>
					) : null}
					{devices.length ? (
						<ul className="pair-device-list" aria-label="Paired devices">
							{devices.map((device) => (
								<li key={device.id}>
									<span>{device.name}</span>
									<button
										type="button"
										className="button button-sm button-danger"
										onClick={() => {
											void client
												.terminalAction({ action: "revoke-device", id: device.id })
												.then((result) => {
													if (result.kind === "ok") {
														setDevices((items) => items.filter((item) => item.id !== device.id));
														setError("");
													} else
														setError(
															result.kind === "error" ? result.message : "Sign in on the host first.",
														);
												});
										}}
									>
										Revoke
									</button>
								</li>
							))}
						</ul>
					) : null}
				</>
			) : (
				<p className="muted">Private HTTPS access is not configured on this host.</p>
			)}
			{error ? (
				<p className="form-error" role="alert">
					{error}
				</p>
			) : null}
		</section>
	);
};
