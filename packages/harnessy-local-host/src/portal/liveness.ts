/**
 * Loopback TCP liveness: does anything accept a connection on this port?
 *
 * The probe connects and closes at once. It sends nothing and reads nothing, so
 * the service sees only an empty connection. It never resolves a name: the host
 * is one of the two loopback literals.
 */
import { connect, type Socket } from "node:net";

export type LoopbackHost = "127.0.0.1" | "::1";

/** Resolves `true` when the port accepted a connection within the time limit. Never rejects. */
export type PortProbe = (host: LoopbackHost, port: number) => Promise<boolean>;

export const LIVENESS_TIMEOUT_MS = 300;

/** The socket factory; tests pass one that never connects. */
export type Connect = (options: {
	readonly host: string;
	readonly port: number;
	readonly family: 4 | 6;
}) => Pick<Socket, "setTimeout" | "once" | "destroy">;

export const tcpPortProbe =
	(timeoutMs: number = LIVENESS_TIMEOUT_MS, open: Connect = connect): PortProbe =>
	(host, port) =>
		new Promise((resolveProbe) => {
			const socket = open({ host, port, family: host === "::1" ? 6 : 4 });
			let settled = false;
			const done = (open: boolean) => {
				if (settled) return;
				settled = true;
				socket.destroy();
				resolveProbe(open);
			};
			socket.setTimeout(timeoutMs, () => done(false));
			socket.once("connect", () => done(true));
			socket.once("error", () => done(false));
		});
