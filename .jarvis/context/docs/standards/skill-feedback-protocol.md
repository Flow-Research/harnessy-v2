# Skill feedback protocol

Capture a decision trace when a skill-backed run exposes a reusable missing
step, brittle assumption, deterministic-command gap, provider/runtime gap,
security/package/evidence issue, repeated correction, or user redirection.

Route feedback to the skill that should change. State what happened, why the
current contract was insufficient, and what future runs should check or
automate. Do not create empty traces for normal successful runs. If trace
capture fails, report the failure in the handoff.
