import { describe, expect, it, vi } from "vitest";

import {
	assessLeaseClock,
	isLeaseCurrencyCode,
	LEASE_CLOCK_MAX_REANCHOR_STEP_MS,
	LEASE_CURRENCY_CODES,
	leaseCurrencyEvent,
	stderrLeaseCurrencyReporter,
} from "../src/jarvis/lease-clock.ts";
import { isWriterCheckInconclusiveReason, WriterCheckInconclusiveError } from "../src/jarvis/writer-check.ts";

const assess = (overrides: Partial<Parameters<typeof assessLeaseClock>[0]> = {}) =>
	assessLeaseClock({
		expectedWallMs: 1_000_000,
		nowMs: 1_000_000,
		toleranceMs: 1_000,
		monotonicRegressed: false,
		reanchorable: true,
		...overrides,
	});

describe("lease clock currency", () => {
	it("accepts a clock at, ahead of, or within tolerance behind the expectation", () => {
		expect(assess()).toEqual({ kind: "current" });
		expect(assess({ nowMs: 5_000_000 })).toEqual({ kind: "current" });
		expect(assess({ nowMs: 999_000 })).toEqual({ kind: "current" });
	});

	it("re-anchors a service's backward step up to five minutes, and stops beyond it", () => {
		expect(LEASE_CLOCK_MAX_REANCHOR_STEP_MS).toBe(300_000);
		expect(assess({ nowMs: 998_999 })).toEqual({ kind: "reanchor", stepMs: 1_001 });
		expect(assess({ nowMs: 1_000_000 - 300_000 })).toEqual({ kind: "reanchor", stepMs: 300_000 });
		expect(assess({ nowMs: 1_000_000 - 300_001 })).toEqual({ kind: "stepped_back", stepMs: 300_001 });
	});

	it("never re-anchors without permission, and stops on a regressed monotonic clock or a non-finite reading", () => {
		expect(assess({ nowMs: 990_000, reanchorable: false })).toEqual({ kind: "stepped_back", stepMs: 10_000 });
		expect(assess({ monotonicRegressed: true })).toEqual({ kind: "stepped_back", stepMs: undefined });
		expect(assess({ nowMs: Number.NaN })).toEqual({ kind: "stepped_back", stepMs: undefined });
		expect(assess({ expectedWallMs: Number.POSITIVE_INFINITY })).toEqual({ kind: "stepped_back", stepMs: undefined });
		// Strict comparison for the community runtime: any step back.
		expect(assess({ toleranceMs: 0, nowMs: 999_999, reanchorable: false })).toEqual({
			kind: "stepped_back",
			stepMs: 1,
		});
	});

	it("logs only allow-listed codes and integer steps", () => {
		expect(LEASE_CURRENCY_CODES).toEqual([
			"clock_stepped_back",
			"boot_changed",
			"lease_row_changed",
			"lease_update_failed",
		]);
		expect(leaseCurrencyEvent("lease_clock_reanchored", "meeting", "clock_stepped_back", 90_000)).toEqual({
			event: "lease_clock_reanchored",
			service: "meeting",
			code: "clock_stepped_back",
			stepMs: 90_000,
		});
		expect(leaseCurrencyEvent("lease_currency_failed", "community", "boot_changed")).toEqual({
			event: "lease_currency_failed",
			service: "community",
			code: "boot_changed",
		});
		expect(leaseCurrencyEvent("lease_currency_failed", "meeting", "clock_stepped_back", 1.5)).not.toHaveProperty(
			"stepMs",
		);
		expect(isLeaseCurrencyCode("lease_row_changed")).toBe(true);
		expect(isLeaseCurrencyCode("revoked")).toBe(false);
		expect(isLeaseCurrencyCode(7)).toBe(false);
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			stderrLeaseCurrencyReporter(leaseCurrencyEvent("lease_currency_failed", "meeting", "lease_update_failed"));
			expect(write).toHaveBeenCalledWith(
				'{"event":"lease_currency_failed","service":"meeting","code":"lease_update_failed"}\n',
			);
		} finally {
			write.mockRestore();
		}
	});

	it("pauses a re-anchor under the allow-listed writer-check reason clock_stepped_back", () => {
		expect(new WriterCheckInconclusiveError("clock", "stepped_back").reason).toBe("clock_stepped_back");
		expect(isWriterCheckInconclusiveReason("clock_stepped_back")).toBe(true);
	});
});
