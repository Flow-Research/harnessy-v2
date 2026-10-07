# Built-in Plan Mode

Plan mode now ships with Pi and is inactive by default. This directory remains as a no-op compatibility entry point for legacy extension paths; loading it does not register a second copy.

## Activation

- The model can call `enter_plan_mode` when it decides planning would help.
- `/plan` toggles read-only planning.
- `/plan status` shows current execution progress.
- `Ctrl+Alt+P` toggles planning from the keyboard.
- `pi --plan` starts a session in planning mode.

## Workflow

1. Enter plan mode.
2. Ask the agent to inspect the project and produce numbered steps under a `Plan:` heading.
3. Choose whether to execute, stay in planning, or refine the plan.
4. During execution, `[DONE:n]` markers update the status line and progress widget.

While planning, built-in `edit` and `write` are disabled, other active tools are preserved without widening explicit `--tools` restrictions, and Bash is restricted to the read-only command allowlist. Plan mode cannot classify third-party tools, so only enable extension tools you trust during planning.

The implementation lives in:

- `src/core/extensions/builtin/plan-mode.ts`
- `src/core/extensions/builtin/plan-mode-utils.ts`
