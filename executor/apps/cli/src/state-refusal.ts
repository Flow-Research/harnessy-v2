/**
 * A supervised daemon (launchd / systemd / Scheduled Task) that refuses to
 * start because its local state is unsafe (a symlinked, foreign-owned or
 * hard-linked state path) must not crash-loop: the state does not fix itself
 * between restarts, and every restart would log the same refusal.
 *
 * Under a supervisor the daemon prints the refusal with its recovery command,
 * waits {@link SUPERVISED_REFUSAL_BACKOFF_MS} and exits with
 * {@link SUPERVISED_REFUSAL_EXIT_CODE} (`EX_CONFIG`). The systemd unit lists
 * that code in `RestartPreventExitStatus`, so systemd stops restarting;
 * launchd restarts at most once per back-off period.
 */
import { isLocalStateRefusal } from "@executor-js/local";

export const SUPERVISED_REFUSAL_EXIT_CODE = 78;
export const SUPERVISED_REFUSAL_BACKOFF_MS = 60_000;

export interface SupervisedRefusalHooks {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
  readonly exit?: (code: number) => void;
  readonly backoffMs?: number;
}

/**
 * When `cause` is a local-state refusal and the process is supervised, report
 * it, back off and exit. Returns `false` (doing nothing) otherwise, so the
 * caller surfaces the error as usual.
 */
export const backOffOnSupervisedStateRefusal = async (
  cause: unknown,
  supervised: boolean,
  hooks: SupervisedRefusalHooks = {},
): Promise<boolean> => {
  if (!supervised || !isLocalStateRefusal(cause)) return false;
  const backoffMs = hooks.backoffMs ?? SUPERVISED_REFUSAL_BACKOFF_MS;
  const log = hooks.log ?? ((line: string) => console.error(line));
  log(cause instanceof Error ? cause.message : String(cause));
  log(
    `Executor will not retry for ${Math.round(backoffMs / 1000)} s. After fixing it, run \`executor service restart\`.`,
  );
  await (hooks.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))))(
    backoffMs,
  );
  (hooks.exit ?? ((code: number) => process.exit(code)))(SUPERVISED_REFUSAL_EXIT_CODE);
  return true;
};
