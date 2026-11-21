# Operate the engineering loop on one machine

This page is for the owner of a machine that runs the engineering loop. The loop takes one approved WorkStream task, runs a coding agent on it in an isolated worktree, checks the result, and opens a draft pull request. The loop does not merge, deploy, accept work, or pay.

A worktree is a second working folder of a Git repository. A tick is one admission check of the loop.

## Limits

- The host must be macOS. The loop refuses other platforms.
- The agent is Claude Code on an included subscription. Codex is not a worker.
- One worker runs at a time. The loop makes at most six reservations in 24 hours. It pauses an objective after three unsuccessful attempts.
- A worker has 45 minutes. Verification has 90 more minutes.
- The loop does not run while the computer sleeps.
- A cancelled or failed launch leaves its WorkStream task unusable for a later launch. A new attempt needs a new task.

## Before the first run

1. Install `herdr`, `claude`, `gh`, and the WorkStream command. Sign in to Claude Code with the subscription account.
2. Make sure that the shell profile exports no provider setting. The loop refuses a launch when it finds a name such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_BASE_URL`, or a `CLAUDE_CODE_USE_` switch, in the service environment or in the login shell.
3. Start the herdr server from a terminal.
4. Write the host profile at `~/.config/harnessy/engineering/host.json` with mode 600:

```json
{
  "schema": "harnessy.engineering.host.v1",
  "accountId": "<the account that `claude auth status` reports>",
  "profiles": [
    {
      "id": "harnessy-v2",
      "root": "/absolute/checkout/with/installed/dependencies",
      "base": "main",
      "workstreamCli": ["/absolute/path/to/workstream"],
      "agentDeps": "clone",
      "agentAllow": "Bash(node_modules/.bin/vitest run *),Bash(node_modules/.bin/biome check *)",
      "verify": [["npm", "run", "check"], ["node", "scripts/check-security-invariants.mjs"]],
      "verifyTimeoutMinutes": 30,
      "protected": ["scripts", "qa"],
      "reviewer": "claude"
    }
  ]
}
```

`verify` holds the commands that judge a candidate. Put each required security check in this list. A check that is missing, that fails, or that reports a finding rejects the candidate. `protected` holds path prefixes that define those commands. The loop always protects package files, lockfiles, compiler and formatter settings, and `.github/`.

5. Confirm that extra usage billing is off for the subscription account. Only the account owner can make this statement. The record is valid for 30 days:

```sh
harnessy engineering confirm-extra-usage-off --confirmed-by julian
```

## Approve one job

1. Release a task in WorkStream.
2. Read the digests that a job for the repository must name:

```sh
harnessy engineering digests
```

3. Write a job file. `taskRevision` is the content identity of the task as the contributor sees it. `sourceRevision` is the full commit of the base branch.

```json
{
  "schema": "harnessy.engineering.job.v1",
  "id": "<new UUID>",
  "objective": "<one line; attempts are counted for each objective>",
  "taskId": "<WorkStream task UUID>",
  "taskRevision": "<64 hexadecimal characters>",
  "workspace": "<workspace name>",
  "repository": "harnessy-v2",
  "lane": "maintenance",
  "sourceRevision": "<40 hexadecimal characters>",
  "evaluatorDigest": "<from the digests command>",
  "workloadDigest": "<from the digests command>"
}
```

4. Approve the exact job. The approval is valid for 135 minutes unless you set another time:

```sh
harnessy engineering approve --job /absolute/job.json --expires-minutes 240
```

## Run

Run one tick. The command waits for the worker and for the checks of the pull request:

```sh
harnessy engineering tick
```

Or run a tick every 15 minutes until you stop the command. A stop signal lets the current tick finish:

```sh
harnessy engineering serve
```

Each tick appends one line to `service.jsonl` in the state folder, `~/.local/state/harnessy/engineering`.

## What a tick result means

| Result | Meaning | Action |
| --- | --- | --- |
| `idle` | No approved job exists. | None. |
| `paused` | A probe or a rule refused the launch. The reason names it. No attempt was spent. | Correct the cause. |
| `occupied` | A run is active or its state is not known. Capacity stays held. | Run another tick later. Do not start a second worker. |
| `settled`, "Verified engineering outcome" | A draft pull request exists, its checks passed, and the host commands passed on its exact commit. | Review the pull request. |
| `settled`, another reason | The run failed or was cancelled. The reason is in the run record. | Read the runner report in `outcomes/`. |

A verified outcome is not acceptance, a merge, a deployment, or a payment.

## Inspect and stop

```sh
harnessy engineering status
harnessy engineering events
harnessy engineering cancel --run <run id>
harnessy engineering revoke --grant <grant id>
```

A cancellation request does not prove that the worker stopped. The next tick observes the processes. It settles the run as cancelled only when the agent and its child processes are gone.

## After a subscription limit

When the agent result reports a usage limit, the loop records a pause in `provider-pause.json`. The pause lasts until the reset time in the reply. When the reply has no readable reset time, the pause lasts seven days. After you checked the limit yourself, you can remove the pause:

```sh
harnessy engineering clear-provider-pause --confirmed-by julian
```

## How a candidate is checked

1. The loop rejects a candidate that changes a protected path. A person must review such a change.
2. The loop exports the exact commit into a new private folder.
3. It copies dependencies from the host checkout, not from the worker's folder.
4. It runs each `verify` command in the macOS sandbox with an empty environment, no network, and no write access outside the export.
5. It writes the result to `verification/` in the state folder.

The same check runs before the push and again on the head of the pull request.

When the profile sets `"reviewer": "claude"`, a second reader runs before the push, after the host commands pass. It is one Claude Code call with no tools and no settings. It reads the diff and can only block the candidate: a rejection, a missing result, or a change over 150,000 bytes stops the push. A pass from the reviewer adds nothing to the verdict, because the diff is untrusted text. The result is kept in `agent-reviews/` in the state folder.

## Known gaps

- A limit message that does not reach the agent result file records no pause.
- A process that leaves both the agent's process tree and the worktree folder is not observed.
- The reviewer agent reads the diff only. It does not read the rest of the repository.
- The loop does not submit the WorkStream proof. The runner does that after a person merges the pull request.
