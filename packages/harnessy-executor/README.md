# `@harnessy/executor`

Platform-selecting wrapper for the Executor runtime shipped with Harnessy.
Release builds compile the vendored Executor source, including the recorded
Harnessy cockpit overlay, into OS/CPU-specific optional dependencies.

Executor retains its MIT license and functional `executor` identities behind
the Harnessy engine boundary. This wrapper only owns distribution and platform
selection.
