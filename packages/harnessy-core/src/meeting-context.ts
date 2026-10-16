/**
 * Internal meeting-context contract (gap-closure H-06, synthetic slice).
 *
 * Typed schema, identity, policy and query rules for a private owner catalog of
 * meetings. Nothing here is exported from the package, starts a service, polls a
 * provider, writes a database or publishes. Source artifacts are read through a
 * bounded, link-rejecting reader and are never modified or deleted.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";

import * as Result from "effect/Result";

import { resolveWorkspacePath, type WorkspaceManifest, workspaceRelativePath } from "./workspace.ts";

export const MEETING_CONTEXT_SCHEMA_VERSION = 1 as const;
export const MAX_CONTEXT_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const TRANSCRIPT_NORMALIZATION = "fathom-transcript/v1";
const PREVIEW_CHARS = 160;
const DEFAULT_PACKET_LIMIT = 20;
const MAX_PACKET_LIMIT = 200;

export type MeetingContextErrorCode =
	| "invalid_input"
	| "path_rejected"
	| "link_rejected"
	| "not_found"
	| "not_a_file"
	| "too_large"
	| "annotation_conflict"
	| "not_authorized"
	| "incomplete_inventory";

export class MeetingContextError extends Error {
	readonly code: MeetingContextErrorCode;

	constructor(code: MeetingContextErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = "MeetingContextError";
	}
}

const invalid = (message: string): never => {
	throw new MeetingContextError("invalid_input", message);
};

/** Workspace path helpers and fs calls throw Error instances. */
const failureMessage = (failure: unknown): string => (failure as Error).message;

export const sha256Hex = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const plainText = (value: unknown, label: string): string => {
	if (typeof value !== "string" || !value.trim() || [...value].some((character) => character.charCodeAt(0) < 32))
		return invalid(`Invalid ${label}`);
	return value;
};

/** Canonical JSON with sorted keys, used for generation hashes. */
const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
};

// ---------------------------------------------------------------------------
// Identity

export interface SourceIdentity {
	readonly provider: string;
	/** Stable provider account/tenant scope, e.g. `fathom:team-a`; never a local credential label. */
	readonly scope: string;
	readonly objectId: string;
}

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const SCOPE_PATTERN = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9._-]{1,128}$/u;
const SOURCE_KEY_PATTERN = /^src_[0-9a-f]{32}$/u;
const MEETING_ID_PATTERN = /^mtg_[a-z0-9-]{4,64}$/u;
const TEAM_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export const validateSourceScope = (provider: string, scope: string): void => {
	if (!PROVIDER_PATTERN.test(provider) || !SCOPE_PATTERN.test(scope) || !scope.startsWith(`${provider}:`))
		invalid(`Invalid source scope ${JSON.stringify(scope)} for provider ${JSON.stringify(provider)}`);
};

/** Deterministic, account-scoped dry-run key. Equal object IDs in different scopes never collide. */
export const meetingSourceKey = (identity: SourceIdentity): string => {
	validateSourceScope(identity.provider, identity.scope);
	plainText(identity.objectId, "source object ID");
	return `src_${sha256Hex(JSON.stringify(["meeting-source/v1", identity.provider, identity.scope, identity.objectId])).slice(0, 32)}`;
};

/** Deterministic proposal for a reviewed canonical meeting ID; review may choose another. */
export const proposedMeetingId = (sourceKey: string): string => {
	if (!SOURCE_KEY_PATTERN.test(sourceKey)) invalid("Invalid source key");
	return `mtg_${sha256Hex(`meeting/v1\0${sourceKey}`).slice(0, 32)}`;
};

// ---------------------------------------------------------------------------
// Transcript normalization

export type TranscriptState = "available" | "partial" | "missing" | "unsupported";

export interface TranscriptSegment {
	readonly index: number;
	readonly speaker: string | null;
	readonly timestamp: string | null;
	readonly text: string;
}

export interface NormalizedTranscript {
	readonly normalization: typeof TRANSCRIPT_NORMALIZATION;
	readonly state: TranscriptState;
	readonly segments: ReadonlyArray<TranscriptSegment>;
	/** Provider items that could not be read as a segment. */
	readonly dropped: number;
	readonly sha256: string | null;
	readonly reason: string | null;
}

/** Transcript text is inert data; nothing here interprets it. */
export const normalizeFathomTranscript = (value: unknown): NormalizedTranscript => {
	const result = (
		state: TranscriptState,
		segments: ReadonlyArray<TranscriptSegment>,
		dropped: number,
		reason: string | null,
	): NormalizedTranscript => ({
		normalization: TRANSCRIPT_NORMALIZATION,
		state,
		segments,
		dropped,
		sha256: segments.length === 0 ? null : sha256Hex(JSON.stringify([TRANSCRIPT_NORMALIZATION, segments])),
		reason,
	});
	if (value === undefined || value === null) return result("missing", [], 0, "provider payload has no transcript");
	if (!Array.isArray(value)) return result("unsupported", [], 0, "transcript is not a segment list");
	const segments: TranscriptSegment[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.text !== "string" || !item.text.trim()) continue;
		const speaker = isRecord(item.speaker) ? item.speaker.display_name : undefined;
		segments.push({
			index: segments.length,
			speaker: typeof speaker === "string" && speaker.trim() ? speaker.trim() : null,
			timestamp: typeof item.timestamp === "string" && item.timestamp.trim() ? item.timestamp.trim() : null,
			text: item.text,
		});
	}
	const dropped = value.length - segments.length;
	if (value.length === 0) return result("missing", [], 0, "provider returned an empty transcript");
	if (segments.length === 0) return result("unsupported", [], dropped, "no transcript item has readable text");
	return dropped > 0
		? result("partial", segments, dropped, `${dropped} of ${value.length} transcript items are unreadable`)
		: result("available", segments, 0, null);
};

export const transcriptPreview = (segments: ReadonlyArray<TranscriptSegment>): string | null =>
	segments.length === 0
		? null
		: segments
				.map((segment) => segment.text)
				.join(" ")
				.slice(0, PREVIEW_CHARS);

// ---------------------------------------------------------------------------
// Bounded, link-rejecting artifact reader

export interface ContextArtifactBytes {
	readonly ref: string;
	readonly bytes: Buffer;
	readonly sha256: string;
}

/**
 * Walk a context-root-relative path one component at a time with lstat. Any
 * symbolic link, including one pointing back inside the root, is rejected.
 * Returns the final entry's stat, or null when a component does not exist.
 */
/** A normalized context-root-relative reference, or a typed `path_rejected` error. */
export const contextRef = (ref: string): string => {
	const result = Result.try(() => workspaceRelativePath(ref));
	if (Result.isFailure(result)) throw new MeetingContextError("path_rejected", failureMessage(result.failure));
	return result.success;
};

export const lstatContextPath = (contextRoot: string, ref: string): Stats | null => {
	const path = contextRef(ref);
	const root = realpathSync(contextRoot);
	const contained = Result.try(() => resolveWorkspacePath(root, path));
	if (Result.isFailure(contained)) throw new MeetingContextError("link_rejected", failureMessage(contained.failure));
	let current = root;
	let stat: Stats | undefined;
	for (const part of path.split("/")) {
		current = join(current, part);
		stat = lstatSync(current, { throwIfNoEntry: false });
		if (stat === undefined) return null;
		if (stat.isSymbolicLink()) throw new MeetingContextError("link_rejected", `Symbolic link rejected: ${ref}`);
	}
	// A normalized reference has at least one component, so the loop assigned a stat.
	return stat as Stats;
};

export const readContextArtifact = (
	contextRoot: string,
	ref: string,
	maxBytes: number = MAX_CONTEXT_ARTIFACT_BYTES,
): ContextArtifactBytes => {
	const stat = lstatContextPath(contextRoot, ref);
	if (stat === null) throw new MeetingContextError("not_found", `Artifact not found: ${ref}`);
	if (!stat.isFile()) throw new MeetingContextError("not_a_file", `Artifact is not a regular file: ${ref}`);
	if (stat.size > maxBytes) throw new MeetingContextError("too_large", `Artifact exceeds ${maxBytes} bytes: ${ref}`);
	// O_NOFOLLOW and the inode check close the window between lstat and open.
	const fd = openSync(join(realpathSync(contextRoot), ref), constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		if (opened.ino !== stat.ino || opened.dev !== stat.dev)
			throw new MeetingContextError("link_rejected", `Artifact changed during read: ${ref}`);
		if (opened.size > maxBytes)
			throw new MeetingContextError("too_large", `Artifact exceeds ${maxBytes} bytes: ${ref}`);
		const bytes = readFileSync(fd);
		return { ref, bytes, sha256: sha256Hex(bytes) };
	} finally {
		closeSync(fd);
	}
};

// ---------------------------------------------------------------------------
// Catalog schema

/** A source observed by the read-only inventory. */
export interface IndexedSource {
	readonly sourceKey: string;
	readonly provider: string;
	readonly scope: string;
	readonly objectId: string;
	readonly accountLabel: string;
	/** Context-root-relative reference to the retained source bytes. */
	readonly ref: string;
	readonly sha256: string;
	readonly transcript: {
		readonly state: TranscriptState;
		/** Normalized transcript hash; null when there is no readable segment. */
		readonly sha256: string | null;
		readonly segmentCount: number;
		readonly dropped: number;
		readonly preview: string | null;
		readonly reason: string | null;
	};
	/** Hash of a provider-generated summary; never a transcript substitute. */
	readonly providerSummarySha256: string | null;
}

export type ArtifactKind = "transcript" | "provider-summary" | "attachment";

export interface ArtifactRevision {
	readonly artifactId: string;
	readonly kind: ArtifactKind;
	readonly sourceRevision: number;
	readonly ref: string;
	/** Hash of the actual retained bytes at `ref`. */
	readonly sha256: string;
	readonly state: TranscriptState;
	/** Content identity: normalized transcript, summary text or attachment bytes. Revisions follow it. */
	readonly contentSha256: string | null;
	readonly segmentCount: number;
	readonly preview: string | null;
}

export interface Citation {
	readonly artifactId: string;
	readonly sourceRevision: number;
	readonly segment: number;
}

export interface Decision {
	readonly text: string;
	readonly citation: Citation;
}

export interface Annotation {
	readonly revision: number;
	readonly title: string | null;
	/** Workspace-qualified `<workspace-id>/<project-id>`; empty means unassigned. */
	readonly projects: ReadonlyArray<string>;
	readonly decisions: ReadonlyArray<Decision>;
}

export interface MeetingRecord {
	readonly meetingId: string;
	readonly sourceKeys: ReadonlyArray<string>;
	/** Legacy note references retained as evidence only; they confer no identity. */
	readonly legacyRefs: ReadonlyArray<string>;
	readonly sourceRevision: number;
	/** Every artifact revision is retained. */
	readonly artifacts: ReadonlyArray<ArtifactRevision>;
	readonly annotation: Annotation;
}

/** Synthetic slice retention: declared, and deletes nothing. */
export interface RetentionPolicy {
	readonly policy: "retain-source-artifacts";
	readonly deletesSourceArtifacts: false;
}

export const SYNTHETIC_RETENTION: RetentionPolicy = {
	policy: "retain-source-artifacts",
	deletesSourceArtifacts: false,
};

export interface MeetingCatalog {
	readonly schemaVersion: typeof MEETING_CONTEXT_SCHEMA_VERSION;
	readonly workspaceId: string;
	/** The catalog is private to its owner by default. */
	readonly owner: string;
	readonly retention: RetentionPolicy;
	readonly meetings: ReadonlyArray<MeetingRecord>;
}

export const catalogGeneration = (catalog: MeetingCatalog): string => `gen_${sha256Hex(canonicalJson(catalog))}`;

const projectIds = (workspace: WorkspaceManifest): ReadonlySet<string> =>
	new Set(workspace.projects.map((project) => `${workspace.id}/${project.id}`));

const validateProjects = (workspace: WorkspaceManifest, projects: ReadonlyArray<string>): ReadonlyArray<string> => {
	const known = projectIds(workspace);
	for (const project of projects)
		if (!known.has(project)) invalid(`Unknown workspace-qualified project ${JSON.stringify(project)}`);
	if (new Set(projects).size !== projects.length) invalid("Duplicate project relationship");
	return [...projects].sort();
};

/** Artifacts are append-only in source-revision order, so the last match is the latest. */
const latestArtifact = (meeting: MeetingRecord, artifactId: string): ArtifactRevision | undefined =>
	meeting.artifacts.filter((artifact) => artifact.artifactId === artifactId).at(-1);

const findArtifact = (meeting: MeetingRecord, citation: Omit<Citation, "segment">): ArtifactRevision | undefined =>
	meeting.artifacts.find(
		(artifact) => artifact.artifactId === citation.artifactId && artifact.sourceRevision === citation.sourceRevision,
	);

const validateDecisions = (meeting: MeetingRecord, decisions: ReadonlyArray<Decision>): ReadonlyArray<Decision> =>
	decisions.map((decision) => {
		const artifact = findArtifact(meeting, decision.citation);
		if (
			artifact === undefined ||
			artifact.kind !== "transcript" ||
			!Number.isInteger(decision.citation.segment) ||
			decision.citation.segment < 0 ||
			decision.citation.segment >= artifact.segmentCount
		)
			invalid(`Decision cites an unknown transcript segment in ${meeting.meetingId}`);
		return { text: plainText(decision.text, "decision text"), citation: { ...decision.citation } };
	});

const sourceArtifacts = (source: IndexedSource, sourceRevision: number): ReadonlyArray<ArtifactRevision> => [
	{
		artifactId: `transcript/${source.sourceKey}`,
		kind: "transcript",
		sourceRevision,
		ref: source.ref,
		sha256: source.sha256,
		state: source.transcript.state,
		contentSha256: source.transcript.sha256,
		segmentCount: source.transcript.segmentCount,
		preview: source.transcript.preview,
	},
	...(source.providerSummarySha256 !== null
		? [
				{
					artifactId: `provider-summary/${source.sourceKey}`,
					kind: "provider-summary" as const,
					sourceRevision,
					ref: source.ref,
					sha256: source.sha256,
					state: "available" as const,
					contentSha256: source.providerSummarySha256,
					segmentCount: 0,
					preview: null,
				},
			]
		: []),
];

export interface InventoryForCatalog {
	readonly status: string;
	readonly entries: ReadonlyArray<{ readonly ref: string; readonly source: IndexedSource | null }>;
}

const indexedSources = (inventory: InventoryForCatalog): ReadonlyMap<string, IndexedSource> => {
	if (inventory.status !== "complete")
		throw new MeetingContextError(
			"incomplete_inventory",
			`Catalog input requires a complete inventory, not ${JSON.stringify(inventory.status)}`,
		);
	const sources = new Map<string, IndexedSource>();
	for (const entry of inventory.entries) {
		if (entry.source === null) continue;
		// Two retained copies of one source (e.g. pending and processed) are refused rather than picked between.
		if (sources.has(entry.source.sourceKey))
			invalid(`Source ${entry.source.sourceKey} is retained more than once; review it explicitly`);
		sources.set(entry.source.sourceKey, entry.source);
	}
	return sources;
};

/** Explicit, reviewed identity/project input. Nothing is inferred from titles, dates or filenames. */
export interface MeetingReview {
	readonly meetingId: string;
	readonly sourceKeys: ReadonlyArray<string>;
	readonly legacyRefs?: ReadonlyArray<string>;
	readonly title: string | null;
	readonly projects: ReadonlyArray<string>;
	readonly decisions?: ReadonlyArray<Decision>;
	readonly attachments?: ReadonlyArray<{ readonly name: string; readonly ref: string }>;
}

export interface BuildCatalogInput {
	readonly contextRoot: string;
	readonly workspace: WorkspaceManifest;
	readonly owner: string;
	readonly retention: RetentionPolicy;
	readonly inventory: InventoryForCatalog;
	readonly reviews: ReadonlyArray<MeetingReview>;
}

const validateRetention = (retention: RetentionPolicy): RetentionPolicy => {
	if (retention.policy !== "retain-source-artifacts" || retention.deletesSourceArtifacts !== false)
		invalid("Only the declared non-deleting retention policy is supported");
	return { ...retention };
};

export const buildMeetingCatalog = (input: BuildCatalogInput): MeetingCatalog => {
	const sources = indexedSources(input.inventory);
	const used = new Set<string>();
	const meetingIds = new Set<string>();
	const meetings = input.reviews.map((review): MeetingRecord => {
		if (!MEETING_ID_PATTERN.test(review.meetingId) || meetingIds.has(review.meetingId))
			invalid(`Invalid or duplicate meeting ID ${JSON.stringify(review.meetingId)}`);
		meetingIds.add(review.meetingId);
		if (review.sourceKeys.length === 0) invalid(`${review.meetingId} needs at least one reviewed source`);
		const artifacts: ArtifactRevision[] = [];
		for (const key of review.sourceKeys) {
			const source = sources.get(key);
			if (source === undefined) invalid(`${review.meetingId} references an unknown or unresolved source ${key}`);
			if (used.has(key)) invalid(`Source ${key} is assigned to more than one meeting`);
			used.add(key);
			artifacts.push(...sourceArtifacts(source as IndexedSource, 1));
		}
		for (const attachment of review.attachments ?? []) {
			const bytes = readContextArtifact(input.contextRoot, attachment.ref);
			artifacts.push({
				artifactId: `attachment/${plainText(attachment.name, "attachment name")}`,
				kind: "attachment",
				sourceRevision: 1,
				ref: attachment.ref,
				sha256: bytes.sha256,
				state: "available",
				contentSha256: bytes.sha256,
				segmentCount: 0,
				preview: null,
			});
		}
		if (new Set(artifacts.map((artifact) => artifact.artifactId)).size !== artifacts.length)
			invalid(`${review.meetingId} has duplicate artifact IDs`);
		const legacyRefs = (review.legacyRefs ?? []).map(contextRef).sort();
		const base: MeetingRecord = {
			meetingId: review.meetingId,
			sourceKeys: [...review.sourceKeys].sort(),
			legacyRefs,
			sourceRevision: 1,
			artifacts,
			annotation: {
				revision: 1,
				title: review.title === null ? null : plainText(review.title, "title"),
				projects: validateProjects(input.workspace, review.projects),
				decisions: [],
			},
		};
		return {
			...base,
			annotation: { ...base.annotation, decisions: validateDecisions(base, review.decisions ?? []) },
		};
	});
	return {
		schemaVersion: MEETING_CONTEXT_SCHEMA_VERSION,
		workspaceId: plainText(input.workspace.id, "workspace ID"),
		owner: plainText(input.owner, "owner"),
		retention: validateRetention(input.retention),
		meetings: meetings.sort((a, b) => (a.meetingId < b.meetingId ? -1 : 1)),
	};
};

// ---------------------------------------------------------------------------
// Trusted synthetic membership

export interface MembershipTable {
	readonly revision: number;
	readonly owner: string;
	readonly teams: Readonly<
		Record<string, { readonly projects: ReadonlyArray<string>; readonly members: ReadonlyArray<string> }>
	>;
}

/** An authenticated principal. Only a membership authority can issue one; object literals are refused. */
export interface MeetingPrincipal {
	readonly id: string;
	readonly teams: ReadonlyArray<string>;
	readonly membershipRevision: number;
}

const issuedPrincipals = new WeakMap<object, TrustedSyntheticMembership>();

/**
 * Fixed, trusted membership table for synthetic fixtures. It does not select a
 * production membership authority. Changing membership creates a new authority
 * revision and invalidates every principal issued by an earlier one.
 */
export class TrustedSyntheticMembership {
	readonly revision: number;
	readonly owner: string;
	readonly #teams: ReadonlyMap<
		string,
		{ readonly projects: ReadonlySet<string>; readonly members: ReadonlySet<string> }
	>;

	constructor(table: MembershipTable, workspace: WorkspaceManifest) {
		if (!Number.isInteger(table.revision) || table.revision < 1)
			invalid("Membership revision must be a positive integer");
		this.revision = table.revision;
		this.owner = plainText(table.owner, "membership owner");
		const teams = new Map<string, { projects: ReadonlySet<string>; members: ReadonlySet<string> }>();
		for (const [team, value] of Object.entries(table.teams)) {
			if (!TEAM_PATTERN.test(team)) invalid(`Invalid team ID ${JSON.stringify(team)}`);
			teams.set(team, {
				projects: new Set(validateProjects(workspace, value.projects)),
				members: new Set(value.members.map((member) => plainText(member, "member"))),
			});
		}
		this.#teams = teams;
	}

	/** Successor table; its revision must advance. */
	revise(table: MembershipTable, workspace: WorkspaceManifest): TrustedSyntheticMembership {
		if (table.revision <= this.revision) invalid("Membership revision must advance");
		return new TrustedSyntheticMembership(table, workspace);
	}

	authenticate(id: string): MeetingPrincipal | null {
		const teams = [...this.#teams].filter(([, team]) => team.members.has(id)).map(([name]) => name);
		if (id !== this.owner && teams.length === 0) return null;
		const principal: MeetingPrincipal = Object.freeze({
			id,
			teams: Object.freeze(teams.sort()),
			membershipRevision: this.revision,
		});
		issuedPrincipals.set(principal, this);
		return principal;
	}

	hasTeam(team: string): boolean {
		return this.#teams.has(team);
	}

	teamProjects(team: string): ReadonlySet<string> {
		return this.#teams.get(team)?.projects ?? new Set();
	}
}

const currentPrincipal = (membership: TrustedSyntheticMembership, principal: MeetingPrincipal): boolean =>
	issuedPrincipals.get(principal) === membership && principal.membershipRevision === membership.revision;

// ---------------------------------------------------------------------------
// Access policy: grants name exact artifact revisions

export interface AccessGrant {
	readonly team: string;
	readonly meetingId: string;
	readonly artifactId: string;
	readonly sourceRevision: number;
}

export interface AccessPolicy {
	/** Policy revisions are independent of source and annotation revisions. */
	readonly revision: number;
	readonly owner: string;
	readonly grants: ReadonlyArray<AccessGrant>;
}

export const emptyAccessPolicy = (catalog: MeetingCatalog): AccessPolicy => ({
	revision: 0,
	owner: catalog.owner,
	grants: [],
});

interface OwnerAction {
	readonly catalog: MeetingCatalog;
	readonly membership: TrustedSyntheticMembership;
	readonly principal: MeetingPrincipal;
}

const requireOwner = (action: OwnerAction): void => {
	if (
		!currentPrincipal(action.membership, action.principal) ||
		action.principal.id !== action.catalog.owner ||
		action.membership.owner !== action.catalog.owner
	)
		throw new MeetingContextError(
			"not_authorized",
			"Only the current catalog owner may change policy or annotations",
		);
};

const sameGrant = (a: AccessGrant, b: AccessGrant): boolean =>
	a.team === b.team &&
	a.meetingId === b.meetingId &&
	a.artifactId === b.artifactId &&
	a.sourceRevision === b.sourceRevision;

export const grantArtifactAccess = (
	action: OwnerAction & { readonly policy: AccessPolicy; readonly grant: AccessGrant },
): AccessPolicy => {
	requireOwner(action);
	if (action.policy.owner !== action.catalog.owner) invalid("Policy belongs to another owner");
	const meeting = action.catalog.meetings.find((entry) => entry.meetingId === action.grant.meetingId);
	if (!action.membership.hasTeam(action.grant.team)) invalid(`Unknown team ${JSON.stringify(action.grant.team)}`);
	if (meeting === undefined || findArtifact(meeting, action.grant) === undefined)
		invalid("A grant must name an existing artifact revision");
	if (action.policy.grants.some((grant) => sameGrant(grant, action.grant))) return action.policy;
	return {
		revision: action.policy.revision + 1,
		owner: action.policy.owner,
		grants: [...action.policy.grants, { ...action.grant }],
	};
};

export const revokeArtifactAccess = (
	action: OwnerAction & { readonly policy: AccessPolicy; readonly grant: AccessGrant },
): AccessPolicy => {
	requireOwner(action);
	if (!action.policy.grants.some((grant) => sameGrant(grant, action.grant))) return action.policy;
	return {
		revision: action.policy.revision + 1,
		owner: action.policy.owner,
		grants: action.policy.grants.filter((grant) => !sameGrant(grant, action.grant)),
	};
};

// ---------------------------------------------------------------------------
// Revisions: source refresh and annotations stay separate

/**
 * Apply re-inventoried sources. Unchanged content produces no revision, even
 * when only observation metadata in the retained bytes changed.
 * Changed artifacts are appended at the next source revision; annotations,
 * citations and grants keep their original revisions.
 */
export const refreshMeetingSources = (catalog: MeetingCatalog, inventory: InventoryForCatalog): MeetingCatalog => {
	const sources = indexedSources(inventory);
	return {
		...catalog,
		meetings: catalog.meetings.map((meeting) => {
			const next = meeting.sourceRevision + 1;
			const changed = meeting.sourceKeys.flatMap((key) => {
				const source = sources.get(key);
				if (source === undefined) return [];
				return sourceArtifacts(source, next).filter((artifact) => {
					const latest = latestArtifact(meeting, artifact.artifactId);
					return (
						latest === undefined ||
						latest.contentSha256 !== artifact.contentSha256 ||
						latest.state !== artifact.state
					);
				});
			});
			return changed.length === 0
				? meeting
				: { ...meeting, sourceRevision: next, artifacts: [...meeting.artifacts, ...changed] };
		}),
	};
};

export interface AnnotationChange {
	readonly meetingId: string;
	/** The annotation revision the change was based on; divergent edits are rejected. */
	readonly baseRevision: number;
	readonly title?: string | null;
	readonly projects?: ReadonlyArray<string>;
	readonly decisions?: ReadonlyArray<Decision>;
}

export const annotateMeeting = (
	action: OwnerAction & { readonly workspace: WorkspaceManifest; readonly change: AnnotationChange },
): MeetingCatalog => {
	requireOwner(action);
	const { change } = action;
	const meeting = action.catalog.meetings.find((entry) => entry.meetingId === change.meetingId);
	if (meeting === undefined) return invalid(`Unknown meeting ${change.meetingId}`);
	if (change.baseRevision !== meeting.annotation.revision)
		throw new MeetingContextError(
			"annotation_conflict",
			`Annotation for ${meeting.meetingId} is at revision ${meeting.annotation.revision}, not ${change.baseRevision}`,
		);
	const annotation: Annotation = {
		revision: meeting.annotation.revision + 1,
		title:
			change.title === undefined
				? meeting.annotation.title
				: change.title === null
					? null
					: plainText(change.title, "title"),
		projects:
			change.projects === undefined
				? meeting.annotation.projects
				: validateProjects(action.workspace, change.projects),
		decisions:
			change.decisions === undefined ? meeting.annotation.decisions : validateDecisions(meeting, change.decisions),
	};
	return {
		...action.catalog,
		meetings: action.catalog.meetings.map((entry) => (entry === meeting ? { ...meeting, annotation } : entry)),
	};
};

// ---------------------------------------------------------------------------
// Query packet and full retrieval share one authorization decision

interface AccessInput {
	readonly catalog: MeetingCatalog;
	readonly policy: AccessPolicy;
	readonly membership: TrustedSyntheticMembership;
	readonly principal: MeetingPrincipal;
}

interface MeetingView {
	readonly granted: ReadonlyArray<ArtifactRevision>;
	readonly projects: ReadonlyArray<string>;
}

/** Null means the meeting does not exist for this principal. */
const viewMeeting = (input: AccessInput, meeting: MeetingRecord): MeetingView | null => {
	if (input.principal.id === input.catalog.owner)
		return { granted: meeting.artifacts, projects: meeting.annotation.projects };
	const grants = input.policy.grants.filter(
		(grant) => grant.meetingId === meeting.meetingId && input.principal.teams.includes(grant.team),
	);
	const granted = meeting.artifacts.filter((artifact) =>
		grants.some((grant) => findArtifact(meeting, grant) === artifact),
	);
	if (granted.length === 0) return null;
	const teams = new Set(grants.map((grant) => grant.team));
	const visibleProjects = new Set([...teams].flatMap((team) => [...input.membership.teamProjects(team)]));
	return { granted, projects: meeting.annotation.projects.filter((project) => visibleProjects.has(project)) };
};

const accessValid = (input: AccessInput): boolean =>
	currentPrincipal(input.membership, input.principal) &&
	input.policy.owner === input.catalog.owner &&
	input.membership.owner === input.catalog.owner;

export interface PacketArtifact {
	readonly artifactId: string;
	readonly kind: ArtifactKind;
	readonly sourceRevision: number;
	readonly state: TranscriptState;
	readonly segmentCount: number;
	readonly preview: string | null;
}

export interface PacketMeeting {
	readonly meetingId: string;
	readonly title: string | null;
	readonly projects: ReadonlyArray<string>;
	readonly artifacts: ReadonlyArray<PacketArtifact>;
	readonly decisions: ReadonlyArray<Decision>;
}

export interface MeetingContextPacket {
	readonly schemaVersion: typeof MEETING_CONTEXT_SCHEMA_VERSION;
	readonly catalogGeneration: string;
	readonly policyRevision: number;
	readonly membershipRevision: number;
	readonly principal: string;
	readonly projects: ReadonlyArray<string>;
	/** Bounds describe only meetings this principal may see. */
	readonly bounds: { readonly limit: number; readonly returned: number; readonly truncated: boolean };
	readonly meetings: ReadonlyArray<PacketMeeting>;
}

export type DeniedAccess = { readonly ok: false; readonly reason: "stale_authorization" | "not_found" };

export const queryMeetingContext = (
	input: AccessInput & { readonly projects?: ReadonlyArray<string>; readonly limit?: number },
): { readonly ok: true; readonly packet: MeetingContextPacket } | DeniedAccess => {
	if (!accessValid(input)) return { ok: false, reason: "stale_authorization" };
	const limit = input.limit ?? DEFAULT_PACKET_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PACKET_LIMIT)
		invalid(`Packet limit must be an integer from 1 to ${MAX_PACKET_LIMIT}`);
	const selected = [...new Set(input.projects ?? [])].sort();
	const visible: PacketMeeting[] = [];
	for (const meeting of input.catalog.meetings) {
		const view = viewMeeting(input, meeting);
		if (view === null) continue;
		// Match only on relationships this principal may see; one entry per meeting.
		if (selected.length > 0 && !view.projects.some((project) => selected.includes(project))) continue;
		const grantedIds = new Set(view.granted.map((artifact) => `${artifact.artifactId}@${artifact.sourceRevision}`));
		visible.push({
			meetingId: meeting.meetingId,
			title: meeting.annotation.title,
			projects: view.projects,
			artifacts: view.granted.map((artifact) => ({
				artifactId: artifact.artifactId,
				kind: artifact.kind,
				sourceRevision: artifact.sourceRevision,
				state: artifact.state,
				segmentCount: artifact.segmentCount,
				preview: artifact.preview,
			})),
			decisions: meeting.annotation.decisions.filter((decision) =>
				grantedIds.has(`${decision.citation.artifactId}@${decision.citation.sourceRevision}`),
			),
		});
	}
	return {
		ok: true,
		packet: {
			schemaVersion: MEETING_CONTEXT_SCHEMA_VERSION,
			catalogGeneration: catalogGeneration(input.catalog),
			policyRevision: input.policy.revision,
			membershipRevision: input.membership.revision,
			principal: input.principal.id,
			projects: selected,
			bounds: { limit, returned: Math.min(limit, visible.length), truncated: visible.length > limit },
			meetings: visible.slice(0, limit),
		},
	};
};

export type RetrievedArtifact =
	| {
			readonly ok: true;
			readonly meetingId: string;
			readonly artifactId: string;
			readonly kind: ArtifactKind;
			readonly sourceRevision: number;
			readonly state: TranscriptState;
			readonly segments: ReadonlyArray<TranscriptSegment>;
			readonly text: string | null;
	  }
	| DeniedAccess
	| { readonly ok: false; readonly reason: "source_changed" | "source_unavailable" };

/** Full retrieval of one permitted artifact revision, verified against its recorded bytes. */
export const retrieveMeetingArtifact = (
	input: AccessInput & {
		readonly contextRoot: string;
		readonly meetingId: string;
		readonly artifactId: string;
		readonly sourceRevision: number;
	},
): RetrievedArtifact => {
	if (!accessValid(input)) return { ok: false, reason: "stale_authorization" };
	const meeting = input.catalog.meetings.find((entry) => entry.meetingId === input.meetingId);
	const view = meeting === undefined ? null : viewMeeting(input, meeting);
	const artifact = view?.granted.find(
		(entry) => entry.artifactId === input.artifactId && entry.sourceRevision === input.sourceRevision,
	);
	// Missing and forbidden are indistinguishable to the caller.
	if (artifact === undefined) return { ok: false, reason: "not_found" };
	const read = Result.try(() => readContextArtifact(input.contextRoot, artifact.ref));
	if (Result.isFailure(read)) return { ok: false, reason: "source_unavailable" };
	const bytes = read.success;
	const base = {
		ok: true as const,
		meetingId: input.meetingId,
		artifactId: artifact.artifactId,
		kind: artifact.kind,
		sourceRevision: artifact.sourceRevision,
		state: artifact.state,
	};
	if (artifact.kind === "attachment")
		return bytes.sha256 === artifact.contentSha256
			? { ...base, segments: [], text: bytes.bytes.toString("utf8") }
			: { ok: false, reason: "source_changed" };
	const parsed = Result.try((): unknown => JSON.parse(bytes.bytes.toString("utf8")));
	if (Result.isFailure(parsed)) return { ok: false, reason: "source_changed" };
	const envelope = parsed.success;
	const payload: Record<string, unknown> = isRecord(envelope) && isRecord(envelope.payload) ? envelope.payload : {};
	if (artifact.kind === "provider-summary") {
		const text = providerSummaryText(payload);
		return text !== null && sha256Hex(text) === artifact.contentSha256
			? { ...base, segments: [], text }
			: { ok: false, reason: "source_changed" };
	}
	// A retained revision is served only while its exact normalized content is still held.
	const transcript = normalizeFathomTranscript(payload.transcript);
	return transcript.sha256 === artifact.contentSha256 && transcript.state === artifact.state
		? { ...base, segments: transcript.segments, text: null }
		: { ok: false, reason: "source_changed" };
};

export const providerSummaryText = (payload: Record<string, unknown>): string | null => {
	const summary = payload.default_summary;
	return isRecord(summary) && typeof summary.markdown_formatted === "string" && summary.markdown_formatted.trim()
		? summary.markdown_formatted
		: null;
};
