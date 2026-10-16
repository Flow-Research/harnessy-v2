# Harnessy V2 ownership

| Role | Responsibility | Required approval |
|---|---|---|
| Harnessy maintainers | Canonical architecture, protected branches, release acceptance, and migration ordering | Merge, branch-protection, version/tag, publication, and license decisions |
| V1 operations owner | Existing Jarvis/scheduler state and the one-writer boundary | Backup, stop/start, schedule rebinding, smoke, rollback, and read-only transition |
| Implementation agent | Branch-local code, tests, context, and reproducible local evidence | May not push, publish, deploy, access credentials, or alter live writers without authorization |
| QA/release verifier | Independent rerun of deterministic gates and false-green review | Must distinguish local command output from hosted and operational evidence |
| Garden consumer team | Hosted product integration against stable Harnessy contracts | Does not own reusable Harnessy runtime/capability source |
| Executor boundary owner | Credential, policy, approval, audit, and host/runtime behavior | Vendored changes must remain explicit and reviewed |

No individual contact or private operational detail is stored in this public
context vault.
