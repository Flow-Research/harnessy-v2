import { describe, expect, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { secureLocalStateDir } from "@executor-js/local";

import {
  backOffOnSupervisedStateRefusal,
  SUPERVISED_REFUSAL_BACKOFF_MS,
  SUPERVISED_REFUSAL_EXIT_CODE,
} from "./state-refusal";
import { generateSystemdUnit } from "./service";

const realRefusal = (): unknown => {
  const root = mkdtempSync(join(tmpdir(), "exec-refusal-"));
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: capture the real refusal, then clean up
  try {
    const target = join(root, "real");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(root, "link"), "dir");
    secureLocalStateDir(join(root, "link"));
    return null;
  } catch (cause) {
    return cause;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const recorder = () => {
  const calls: string[] = [];
  return {
    calls,
    hooks: {
      log: (line: string) => calls.push(`log ${line.split("\n")[0]}`),
      sleep: async (ms: number) => {
        calls.push(`sleep ${ms}`);
      },
      exit: (code: number) => {
        calls.push(`exit ${code}`);
      },
    },
  };
};

describe("backOffOnSupervisedStateRefusal", () => {
  it("backs off, then exits with EX_CONFIG for a supervised state refusal", async () => {
    const cause = realRefusal();
    const { calls, hooks } = recorder();
    expect(
      await backOffOnSupervisedStateRefusal(new Error("wrapped", { cause }), true, hooks),
    ).toBe(true);
    expect(calls.at(-2)).toBe(`sleep ${SUPERVISED_REFUSAL_BACKOFF_MS}`);
    expect(calls.at(-1)).toBe(`exit ${SUPERVISED_REFUSAL_EXIT_CODE}`);
    expect(SUPERVISED_REFUSAL_EXIT_CODE).toBe(78);
    expect(SUPERVISED_REFUSAL_BACKOFF_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("logs the refusal with its recovery command", async () => {
    const cause = realRefusal();
    const lines: string[] = [];
    await backOffOnSupervisedStateRefusal(cause, true, {
      log: (line) => lines.push(line),
      sleep: async () => {},
      exit: () => {},
    });
    expect(lines.join("\n")).toMatch(/symbolic link[\s\S]*To recover:[\s\S]*service restart/);
  });

  it("does nothing outside a supervisor or for other failures", async () => {
    const { calls, hooks } = recorder();
    expect(await backOffOnSupervisedStateRefusal(realRefusal(), false, hooks)).toBe(false);
    expect(await backOffOnSupervisedStateRefusal(new Error("port in use"), true, hooks)).toBe(
      false,
    );
    expect(calls).toEqual([]);
  });
});

describe("systemd unit", () => {
  it("does not restart after an EX_CONFIG state refusal", () => {
    const unit = generateSystemdUnit({
      execStart: ["/usr/bin/executor", "daemon", "run"],
      environment: {},
      workingDirectory: "/home/me",
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log",
    });
    expect(unit).toContain(`RestartPreventExitStatus=${SUPERVISED_REFUSAL_EXIT_CODE}`);
  });
});
