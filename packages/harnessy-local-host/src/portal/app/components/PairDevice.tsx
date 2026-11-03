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
		<section>
			<h3>Connect a device</h3>
			<p>
				Open a one-time link on your device. It grants access to your workspace and terminals for 30 days, unless
				revoked here.
			</p>
			{origin ? (
				<>
					<label>
						Device name
						<input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
					</label>
					<button
						type="button"
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
						<label>
							Open on your device within 60 seconds
							<input readOnly value={url} onFocus={(e) => e.target.select()} />
						</label>
					) : null}
					{devices.map((device) => (
						<p key={device.id}>
							{device.name}{" "}
							<button
								type="button"
								onClick={() => {
									void client.terminalAction({ action: "revoke-device", id: device.id }).then((result) => {
										if (result.kind === "ok")
											setDevices((items) => items.filter((item) => item.id !== device.id));
									});
								}}
							>
								Revoke
							</button>
						</p>
					))}
				</>
			) : (
				<p>Private HTTPS access is not configured on this host.</p>
			)}
			{error ? <p role="alert">{error}</p> : null}
		</section>
	);
};
