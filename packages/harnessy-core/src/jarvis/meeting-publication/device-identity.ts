import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";

/** macOS device numbers change after remounts. Bind durable records to the volume UUID. */
export const makePublicationDeviceIdentity = (
	platform: string,
	run: (command: string, args: string[]) => string,
	deviceOf: (path: string) => bigint,
) => {
	const volumes = new Map<string, string>();
	return (path: string, device: bigint): string => {
		if (platform !== "darwin") return device.toString();
		const cached = volumes.get(device.toString());
		if (cached !== undefined) return cached;
		const filesystem = run("/bin/df", ["-P", path])
			.split("\n")[1]
			?.match(/^(\/dev\/disk[0-9]+s[0-9]+(?:s[0-9]+)?)\s/u)?.[1];
		if (filesystem === undefined) throw new Error("volume_identity_unavailable");
		const plist = run("/usr/sbin/diskutil", ["info", "-plist", filesystem]);
		const uuid = plist.match(
			/<key>VolumeUUID<\/key>\s*<string>([A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12})<\/string>/u,
		)?.[1];
		if (uuid === undefined || deviceOf(path) !== device) throw new Error("volume_identity_unavailable");
		const identity = `volume:${uuid.toLowerCase()}`;
		volumes.set(device.toString(), identity);
		return identity;
	};
};

export const publicationDeviceIdentity = makePublicationDeviceIdentity(
	process.platform,
	(command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024 }),
	(path) => lstatSync(path, { bigint: true }).dev,
);

/** Legacy numeric pins remain boot-local; newly prepared records use a persistent volume identity. */
export const publicationDeviceMatches = (path: string, device: bigint, expected: string): boolean =>
	expected.startsWith("volume:")
		? publicationDeviceIdentity(path, device) === expected
		: device.toString() === expected;
