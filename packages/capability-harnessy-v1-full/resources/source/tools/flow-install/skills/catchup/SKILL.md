---
name: catchup
description: Bring the user back up to speed after they switch back into this agent session. Use when the user types /catchup, or says "bring me up to speed", "where are we", "what's going on", "catch me up". Produces a one-paragraph brief of the session and switches replies to one-paragraph mode.
---

# Catch up

The user has been working in other agent tabs and is switching back into this one. Give them back the context in a single read.

## Produce the brief

Write exactly one short paragraph in plain words. Cover these points in this order, and leave out any point that has nothing to say:

1. **Goal:** what this session is trying to achieve, in one clause.
2. **Decided:** the key decisions already made, especially ones the user made. Keep any qualifiers that change their meaning.
3. **Current state:** what was done most recently, and what is running in the background (agents, builds, CI).
4. **Waiting on you:** the open questions or blockers that need the user. Phrase these as direct questions.
5. **Next step:** what happens next, and who does it.

Rules:
- Build the brief from this conversation and any files or tools it used. Re-check facts that may have changed, such as CI status or background tasks, before reporting them. Don't guess.
- Say what is verified and what is assumed. Never call something done if it wasn't verified.
- Keep exact names, paths, numbers, PR numbers and identifiers.
- Don't do new work, start tools that change state, or repeat earlier explanations.
- Don't use headings, bullets or preamble. Write only the paragraph.

## After the brief

For the rest of the conversation, keep every reply to one simple paragraph that goes straight to the point but still carries the context the user needs. Keep doing this until the user says otherwise.

If the user names a topic along with the request, focus the brief on that topic.
