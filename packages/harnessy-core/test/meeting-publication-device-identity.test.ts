import { describe, expect, it, vi } from "vitest";
import { makePublicationDeviceIdentity } from "../src/jarvis/meeting-publication/device-identity.ts";

const uuid = "ADFB224D-039E-491B-95C0-A3A07732AE71";
describe("durable macOS publication volume bindings", () => {
	it("retains the same binding after reboot changes the disk number and caches one probe per device", () => {
		const probe = vi.fn((command: string) =>
			command === "/bin/df"
				? "Filesystem blocks\n/dev/disk3s5 1 1 1 /mount\n"
				: `<key>VolumeUUID</key><string>${uuid}</string>`,
		);
		let device = 16n;
		const read = makePublicationDeviceIdentity("darwin", probe, () => device);
		const before = read("/state", device);
		expect(read("/other", device)).toBe(before);
		expect(probe).toHaveBeenCalledTimes(2);
		device = 17n;
		const afterBoot = makePublicationDeviceIdentity("darwin", probe, () => device);
		expect(afterBoot("/state", device)).toBe(before);
		expect(before).toBe(`volume:${uuid.toLowerCase()}`);
	});
	it("rejects unavailable volume identity and a file moved during the probe", () => {
		const invalid = makePublicationDeviceIdentity(
			"darwin",
			() => "",
			() => 16n,
		);
		expect(() => invalid("/state", 16n)).toThrow("volume_identity_unavailable");
		const moved = makePublicationDeviceIdentity(
			"darwin",
			(command) =>
				command === "/bin/df" ? "header\n/dev/disk3s5 1" : `<key>VolumeUUID</key><string>${uuid}</string>`,
			() => 17n,
		);
		expect(() => moved("/state", 16n)).toThrow("volume_identity_unavailable");
	});
	it("does not invoke macOS utilities on Linux", () => {
		const probe = vi.fn(() => "");
		expect(makePublicationDeviceIdentity("linux", probe, () => 16n)("/state", 16n)).toBe("16");
		expect(probe).not.toHaveBeenCalled();
	});
});
