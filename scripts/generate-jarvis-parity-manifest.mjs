#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		commands: { type: "string", default: "packages/harnessy-core/fixtures/jarvis-v1/command-manifest.json" },
		state: { type: "string", default: "packages/harnessy-core/fixtures/jarvis-v1/state-manifest.json" },
		output: { type: "string", default: "packages/harnessy-core/fixtures/jarvis-v1/parity-manifest.json" },
		"meeting-output": {
			type: "string",
			default: "packages/harnessy-core/fixtures/jarvis-v1/meeting-publication-parity.json",
		},
		check: { type: "boolean", default: false },
	},
});

const commandManifest = JSON.parse(await readFile(resolve(values.commands), "utf8"));
const stateManifest = JSON.parse(await readFile(resolve(values.state), "utf8"));

const nativeMeetingFoundationCommands = new Set([
	"jarvis meeting publish",
	"jarvis meeting publish approve",
	"jarvis meeting publish preflight",
	"jarvis meeting publish reject",
	"jarvis meeting publish scan",
	"jarvis meeting publish status",
	"jarvis meeting publish worker",
]);

const retiredCommand = (command) => {
	const reference = command.path.join(" ");
	const shorthand = command.path[1];
	if (["j", "t", "o", "rl", "p", "n"].includes(shorthand) || shorthand === "w") {
		return {
			replacement:
				shorthand === "w"
					? ["jarvis", "wiki", ...command.path.slice(2)].join(" ")
					: "Canonical hsy domain tool, slash command, skill, or CLI surface",
			rationale: "Aliases are compatibility conveniences, not independent native protocol nodes.",
		};
	}
	if (shorthand === "android" || shorthand === "apk") {
		return {
			replacement: "Optional Android host capability",
			rationale: "Android SDK requirements do not belong in the portable core.",
		};
	}
	if (reference === "jarvis docs") {
		return {
			replacement: "Generated hsy CLI, tool-schema, slash-command, and skill documentation",
			rationale: "Documentation is generated from native definitions rather than maintained as a legacy command registry.",
		};
	}
	if (reference === "jarvis wiki open") {
		return {
			replacement: "Optional Obsidian desktop capability",
			rationale: "Core preserves URL generation without depending on a desktop application.",
		};
	}
	if (
		[
			"jarvis meeting fathom start",
			"jarvis meeting fathom webhook serve",
			"jarvis whatsapp webhook serve",
		].includes(reference)
	) {
		return {
			replacement: "Separate Effect channel daemon plus optional hsy daemon supervision",
			rationale: "Persistent receivers do not run inside the interactive agent process.",
		};
	}
};

const commandEntries = commandManifest.commands.map((command) => {
	const reference = command.path.join(" ");
	const retirement = retiredCommand(command);
	return {
		id: `command:${command.path.join(":")}`,
		surface: "command",
		legacyReference: reference,
		status:
			retirement === undefined
				? reference === "jarvis" || nativeMeetingFoundationCommands.has(reference)
					? "partial"
					: "missing"
				: "intentionally-retired",
		...(retirement ??
			(reference === "jarvis"
				? { replacement: "hsy jarvis", rationale: "The native compatibility command group is available." }
				: nativeMeetingFoundationCommands.has(reference)
					? {
						replacement: "MeetingPublicationService/MeetingPublicationStore",
						rationale:
							"Native domain and local production-shaped provider behavior exist, but CLI/host wiring and activation remain pending.",
					}
				: {})),
	};
});

const stateEntries = stateManifest.stores.map((store) => {
	const compatibility =
		store.id === "project-context-v1"
			? { replacement: "JarvisContextLoader", rationale: "The native loader reproduces the twelve-file legacy merge contract." }
			: store.id === "legacy-config-yaml-v1"
				? {
						replacement: "JarvisConfigReader",
						rationale: "Effect schemas reproduce legacy YAML, environment, account, and credential-source resolution.",
					}
				: {
						replacement: "JarvisStateReader",
						rationale: "The bounded native reader reports versioned readiness without mutating legacy state.",
					};
	return {
		id: `state:${store.id}`,
		surface: "state",
		legacyReference: store.id,
		status: "compatible",
		...compatibility,
	};
});

const contextFiles = [
	"preferences.md",
	"patterns.md",
	"constraints.md",
	"priorities.md",
	"goals.md",
	"projects.md",
	"recurring.md",
	"focus.md",
	"blockers.md",
	"calendar.md",
	"delegation.md",
	"decisions.md",
];

const contextEntries = contextFiles.map((file) => ({
	id: `context:${file}`,
	surface: "context",
	legacyReference: file,
	status: "compatible",
	replacement: "JarvisContextLoader",
	rationale: "Global/project precedence and {{global}} expansion are covered by native compatibility tests.",
}));

const plannedEntries = [
	["connector:anytype", "connector", "AnyTypeAdapter", "partial", "Focused Effect knowledge services", "Existing native reads cover list spaces, search, and get object."],
	["connector:notion", "connector", "NotionAdapter", "missing"],
	["workflow:tasks-planning", "workflow", "task/analyzer/plan", "missing"],
	["workflow:journal-notes", "workflow", "journal/note", "missing"],
	["workflow:reading-content-sync", "workflow", "reading_list/content/sync", "missing"],
	["workflow:wiki", "workflow", "wiki", "missing"],
	["channel:meetings", "channel", "meetings", "partial", "MeetingPublicationService/MeetingPublicationReviewServer", "Native lifecycle, secure loopback review, checkpointing, and production-shaped provider adapters exist locally; CLI/host integration, live credentials, and activation remain pending."],
	["channel:fathom", "channel", "meetings/fathom", "missing"],
	["channel:whatsapp", "channel", "whatsapp", "missing"],
	["host-capability:android", "host-capability", "android/apk", "intentionally-retired", "Optional Android host capability", "Android SDK requirements do not belong in the portable core."],
	["host-capability:tmux", "host-capability", "tmux process management", "intentionally-retired", "Optional process-supervision capability", "Interactive hsy does not own persistent process supervision."],
	["host-capability:cloudflared", "host-capability", "cloudflared tunnel launch", "intentionally-retired", "Optional tunnel capability", "Tunnel lifecycle is separate from channel domain services."],
	["host-capability:shell-profile", "host-capability", "shell profile mutation", "intentionally-retired", "Optional shell integration capability", "Core services must not mutate shell startup files."],
	["host-capability:obsidian-open", "host-capability", "Obsidian launching", "intentionally-retired", "Optional desktop integration capability", "Core preserves URL generation without depending on a desktop application."],
].map(([id, surface, legacyReference, status, replacement, rationale]) => ({
	id,
	surface,
	legacyReference,
	status,
	...(replacement === undefined ? {} : { replacement }),
	...(rationale === undefined ? {} : { rationale }),
}));

const entries = [...commandEntries, ...stateEntries, ...contextEntries, ...plannedEntries].sort((left, right) => left.id.localeCompare(right.id));
const manifest = { schemaVersion: 1, sourceVersion: commandManifest.source.version, entries };

const meetingOraclePaths = [
	"packages/capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/meetings/publication/models.py",
	"packages/capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/meetings/publication/notes.py",
	"packages/capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/meetings/publication/store.py",
	"packages/capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/meetings/publication/service.py",
	"packages/capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/meetings/publication/review.py",
	"packages/capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/meetings/publication/discord.py",
	"packages/capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/meetings/publication/google.py",
	"packages/capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/meetings/publication/notify.py",
	"packages/capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/meetings/publication/markdown.py",
	"packages/capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/meetings/publication/errors.py",
];
const meetingOracleSources = await Promise.all(
	meetingOraclePaths.map(async (path) => {
		const content = await readFile(resolve(path));
		return { path, sha256: createHash("sha256").update(content).digest("hex") };
	}),
);
const meetingStatuses = [
	"pending_review",
	"approved",
	"publishing",
	"published",
	"rejected",
	"blocked",
	"archived",
];
const meetingTransitionCases = [
	["update-pending", "pending_review", "update", "pending_review"],
	["approve-pending", "pending_review", "approve", "approved"],
	["reject-pending", "pending_review", "reject", "rejected"],
	["archive-pending", "pending_review", "archive", "archived"],
	["claim-approved", "approved", "claim", "publishing"],
	["archive-approved", "approved", "archive", "archived"],
	["retry-publishing", "publishing", "retry", "approved"],
	["block-publishing", "publishing", "block", "blocked"],
	["publish-publishing", "publishing", "publish", "published"],
	["approve-blocked", "blocked", "approve", "approved"],
	["restore-archived", "archived", "restore", "pending_review"],
	["change-approved", "approved", "source_changed", "pending_review"],
	["change-publishing", "publishing", "source_changed", "pending_review"],
	["change-rejected", "rejected", "source_changed", "pending_review"],
	["change-blocked", "blocked", "source_changed", "pending_review"],
].map(([id, from, event, expected]) => ({ id, from, event, v1: expected, v2: expected }));
const meetingInvalidTransitionCases = [
	["update-blocked", "blocked", "update"],
	["publish-unreviewed", "pending_review", "publish"],
	["claim-rejected", "rejected", "claim"],
	["approve-published", "published", "approve"],
].map(([id, from, event]) => ({ id, from, event, v1: "rejected", v2: "rejected" }));
const meetingFixture = {
	schemaVersion: 1,
	oracle: {
		kind: "preserved-v1-explicit-contract",
		sources: meetingOracleSources,
	},
	statuses: { v1: meetingStatuses, v2: meetingStatuses },
	transitionCases: meetingTransitionCases,
	invalidTransitionCases: meetingInvalidTransitionCases,
	recoveryCases: [
		{
			id: "expired-lease-google-checkpoint",
			input: { status: "publishing", lease: "expired", googleDocId: "doc-1" },
			v1Expected: { status: "publishing", attemptsDelta: 1, existingGoogleDocId: "doc-1" },
		},
		{
			id: "discord-retry-after",
			input: { status: "publishing", retryAfterSeconds: 10, googleDocId: "doc-1" },
			v1Expected: { status: "approved", retryScheduled: true, existingGoogleDocId: "doc-1" },
		},
		{
			id: "terminal-provider-failure",
			input: { status: "publishing", retryAfterSeconds: null },
			v1Expected: { status: "blocked", retryScheduled: false },
		},
	],
	reviewCases: [
		{
			id: "reviewed-purpose-normalization",
			input: "  Publish the owner reviewed outcome  ",
			v1Expected: { outcome: "accepted", discordPurpose: "Publish the owner reviewed outcome." },
		},
		{
			id: "empty-reviewed-purpose",
			input: "   ",
			v1Expected: { outcome: "rejected" },
		},
		{
			id: "oversized-reviewed-purpose",
			input: "x".repeat(281),
			v1Expected: { outcome: "rejected" },
		},
	],
	reviewLifecycle: {
		retry: "retained",
		restart: "retained",
		sourceChanged: "cleared",
		archive: "cleared",
		published: "cleared",
	},
	canonicalNoteEditing: {
		maxCodePoints: 50_000,
		normalization: "crlf-and-cr-to-lf-trim-single-terminal-newline",
		validation: ["project", "iso-date", "executive-summary", "no-transcript", "item-identity"],
		path: "existing-non-symlink-under-explicit-source-root",
		write: "same-directory-atomic-replace-preserve-mode",
		lifecycle: "pending-review-only-hash-refreshed-approval-cleared",
		providerSideEffects: "none-until-separate-approval",
		reviewAction: "separate-update-note-post",
		defaultMaxFormBytes: 1_000_000,
	},
	privacy: {
		persistedContent: "metadata-digests-and-bounded-transient-purpose-only",
		reviewerPurposeOverride: "bounded-transient-owner-only-queue-state",
		providerResponseBody: "never",
	},
	providerContract: {
		order: ["google", "discord"],
		google: {
			identity: "exact-owner-before-every-write",
			credentialAuthority: "oauth-drive.file",
			folderIdentity: "deterministic-app-property",
			documentIdentity: "meeting-item-app-property",
			update: "replace-existing-document-content",
			publicPermission: "anyone-reader-idempotent",
			duplicateMatch: "terminal-without-duplicate-document-write",
		},
		discord: {
			identity: "bot-and-exact-target-channel-before-every-write",
			create: "item-id-nonce-with-enforcement",
			update: "checkpointed-channel-and-message-without-create-fallback",
			mentions: "suppressed",
			content: "approved-purpose-and-stable-google-url-only",
		},
		failures: {
			terminal: [
				"authentication_failed",
				"permission_denied",
				"provider_not_found",
				"identity_mismatch",
				"duplicate_resource",
				"checkpoint_mismatch",
				"unsafe_redirect",
			],
			transient: [
				"request_timeout",
				"rate_limited",
				"provider_unavailable",
				"network_error",
				"timeout",
				"invalid_response",
				"response_too_large",
			],
			retryAfter: "bounded-positive-seconds-or-safe-default",
		},
		notifier: "content-free-kind-and-count-with-bounded-process-lifecycle",
		persistence: "provider-bodies-and-credentials-never-in-workflow-state",
	},
	providerCases: {
		httpFailures: [
			{ id: "authentication", status: 401, code: "authentication_failed", retryable: false, retryAfterSeconds: null },
			{ id: "permission", status: 403, code: "permission_denied", retryable: false, retryAfterSeconds: null },
			{ id: "not-found", status: 404, code: "provider_not_found", retryable: false, retryAfterSeconds: null },
			{ id: "request-timeout", status: 408, code: "request_timeout", retryable: true, retryAfter: "2", retryAfterSeconds: 2 },
			{ id: "rate-limit", status: 429, code: "rate_limited", retryable: true, retryAfter: "7", retryAfterSeconds: 7 },
			{ id: "unavailable", status: 503, code: "provider_unavailable", retryable: true, retryAfter: "4", retryAfterSeconds: 4 },
			{ id: "redirect", status: 302, code: "unsafe_redirect", retryable: false, retryAfterSeconds: null },
		],
		// V1 keeps retryable meeting queue items eligible until a non-retryable
		// failure; the native queue must not add a cumulative attempt cap.
		retryPolicy: { providerMaxAttempts: null, terminalAttemptSchedulesRetry: true },
		unsafeLoopbackOrigins: [
			"https://127.0.0.1:9443",
			"http://localhost:9443",
			"http://example.test:9443",
			"http://user:secret@127.0.0.1:9443",
			"http://127.0.0.1:9443/provider",
		],
		discordContent: { maxCodePoints: 2000, maxBytes: 8000, escapesMarkupBeforeMeasuring: true },
		lostResponseRecovery: {
			googleDocumentIdentity: "harnessyMeetingItemId",
			discordCreateIdentity: "enforced-item-id-nonce",
		},
	},
};

const emit = async (path, value) => {
	const target = resolve(path);
	const generated = `${JSON.stringify(value, null, 2)}\n`;
	if (values.check) {
		const current = await readFile(target, "utf8").catch(() => "");
		if (current !== generated) throw new Error(`stale generated parity fixture: ${path}`);
		return;
	}
	await writeFile(target, generated, "utf8");
};

await emit(values.output, manifest);
await emit(values["meeting-output"], meetingFixture);
