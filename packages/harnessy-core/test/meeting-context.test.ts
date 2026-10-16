import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	annotateMeeting,
	buildMeetingCatalog,
	catalogGeneration,
	emptyAccessPolicy,
	grantArtifactAccess,
	type MeetingCatalog,
	MeetingContextError,
	type MeetingPrincipal,
	type MeetingReview,
	type MembershipTable,
	meetingSourceKey,
	normalizeFathomTranscript,
	proposedMeetingId,
	queryMeetingContext,
	readContextArtifact,
	retrieveMeetingArtifact,
	revokeArtifactAccess,
	SYNTHETIC_RETENTION,
	TrustedSyntheticMembership,
	transcriptPreview,
} from "../src/meeting-context.ts";
import { collectMeetingInventory, type InventoryReport } from "../src/meeting-context-inventory.ts";
import {
	createContextRoot,
	fathomTranscript,
	GARDEN,
	LIFE,
	OWNER,
	ROOTS,
	removeContextRoots,
	SCOPES,
	segments,
	WORKSPACE,
	WORKSTREAM,
	writeEnvelope,
	writeFile,
} from "./support/meeting-context-fixture.ts";

afterEach(removeContextRoots);

const expectCode = (action: () => unknown, code: MeetingContextError["code"]): void => {
	let failure: unknown;
	try {
		action();
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(MeetingContextError);
	expect((failure as MeetingContextError).code).toBe(code);
};

const key = (objectId: string, scope = "fathom:tenant-flow") =>
	meetingSourceKey({ provider: "fathom", scope, objectId });

const TABLE: MembershipTable = {
	revision: 1,
	owner: OWNER,
	teams: {
		garden: { projects: [GARDEN], members: ["gina@example.test"] },
		workstream: { projects: [WORKSTREAM], members: ["walt@example.test"] },
	},
};

interface Setup {
	readonly root: string;
	readonly inventory: InventoryReport;
	readonly catalog: MeetingCatalog;
	readonly membership: TrustedSyntheticMembership;
	readonly owner: MeetingPrincipal;
}

const setup = (reviews?: ReadonlyArray<MeetingReview>): Setup => {
	const root = createContextRoot();
	writeEnvelope(root, "m1", { transcript: fathomTranscript(segments("m1", 3)), summary: "Summary one." });
	writeEnvelope(root, "m2", { transcript: fathomTranscript(segments("m2", 2)) });
	writeFile(root, "private/owner/attachments/slides.txt", "slides");
	const inventory = collectMeetingInventory({ contextRoot: root, roots: ROOTS, accountScopes: SCOPES });
	const catalog = buildMeetingCatalog({
		contextRoot: root,
		workspace: WORKSPACE,
		owner: OWNER,
		retention: SYNTHETIC_RETENTION,
		inventory,
		reviews: reviews ?? [
			{
				meetingId: "mtg_m001",
				sourceKeys: [key("m1")],
				title: "One",
				projects: [WORKSTREAM, GARDEN],
				attachments: [{ name: "slides", ref: "private/owner/attachments/slides.txt" }],
			},
			{ meetingId: "mtg_m002", sourceKeys: [key("m2")], title: null, projects: [] },
		],
	});
	const membership = new TrustedSyntheticMembership(TABLE, WORKSPACE);
	return { root, inventory, catalog, membership, owner: membership.authenticate(OWNER)! };
};

describe("meeting identity", () => {
	it("derives stable keys scoped by provider tenant", () => {
		expect(key("abc")).toBe(key("abc"));
		expect(key("abc")).toMatch(/^src_[0-9a-f]{32}$/u);
		expect(key("abc", "fathom:tenant-other")).not.toBe(key("abc"));
		expect(proposedMeetingId(key("abc"))).toBe(proposedMeetingId(key("abc")));
		expect(proposedMeetingId(key("abc"))).toMatch(/^mtg_[0-9a-f]{32}$/u);
		expectCode(() => meetingSourceKey({ provider: "Fathom", scope: "Fathom:x", objectId: "1" }), "invalid_input");
		expectCode(() => meetingSourceKey({ provider: "fathom", scope: "zoom:x", objectId: "1" }), "invalid_input");
		expectCode(() => meetingSourceKey({ provider: "fathom", scope: "fathom:", objectId: "1" }), "invalid_input");
		expectCode(() => meetingSourceKey({ provider: "fathom", scope: "fathom:x", objectId: " " }), "invalid_input");
		expectCode(() => meetingSourceKey({ provider: "fathom", scope: "fathom:x", objectId: "a\nb" }), "invalid_input");
		expectCode(() => proposedMeetingId("src_short"), "invalid_input");
	});
});

describe("transcript normalization", () => {
	it("labels availability without substituting other content", () => {
		expect(normalizeFathomTranscript(undefined)).toMatchObject({ state: "missing", sha256: null, segments: [] });
		expect(normalizeFathomTranscript(null).state).toBe("missing");
		expect(normalizeFathomTranscript([])).toMatchObject({
			state: "missing",
			reason: "provider returned an empty transcript",
		});
		expect(normalizeFathomTranscript({ text: "x" }).state).toBe("unsupported");
		expect(normalizeFathomTranscript([1, { text: " " }])).toMatchObject({ state: "unsupported", dropped: 2 });
		const partial = normalizeFathomTranscript([{ text: "kept", speaker: { display_name: " Ada " } }, "lost"]);
		expect(partial).toMatchObject({
			state: "partial",
			dropped: 1,
			segments: [{ index: 0, speaker: "Ada", timestamp: null, text: "kept" }],
		});
		const full = normalizeFathomTranscript([
			{ text: "a", speaker: "flat", timestamp: " 00:01 " },
			{ text: "b", speaker: { display_name: " " }, timestamp: " " },
		]);
		expect(full).toMatchObject({
			state: "available",
			reason: null,
			segments: [
				{ index: 0, speaker: null, timestamp: "00:01", text: "a" },
				{ index: 1, speaker: null, timestamp: null, text: "b" },
			],
		});
		expect(full.sha256).toBe(normalizeFathomTranscript([{ text: "a", timestamp: "00:01" }, { text: "b" }]).sha256);
		expect(transcriptPreview([])).toBeNull();
		expect(transcriptPreview(normalizeFathomTranscript([{ text: "y".repeat(500) }]).segments)).toHaveLength(160);
	});
});

describe("context artifact reader", () => {
	it("reads only regular files inside the root without following links", () => {
		const root = createContextRoot();
		const outside = createContextRoot();
		const ref = writeFile(root, "private/a.txt", "alpha");
		writeFile(outside, "secret.txt", "secret");
		expect(readContextArtifact(root, ref)).toMatchObject({ ref, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
		expect(readContextArtifact(root, ref).bytes.toString()).toBe("alpha");
		for (const path of ["../x", "/etc/passwd", "private/../a", "private//a.txt", "a\\b"])
			expectCode(() => readContextArtifact(root, path), "path_rejected");
		symlinkSync(join(outside, "secret.txt"), join(root, "private/escape.txt"));
		symlinkSync(join(root, ref), join(root, "private/alias.txt"));
		symlinkSync(outside, join(root, "linked"));
		mkdirSync(join(root, "private/dir"));
		symlinkSync(join(root, "private"), join(root, "private/dir/up"));
		expectCode(() => readContextArtifact(root, "private/escape.txt"), "link_rejected");
		expectCode(() => readContextArtifact(root, "private/alias.txt"), "link_rejected");
		expectCode(() => readContextArtifact(root, "linked/secret.txt"), "link_rejected");
		expectCode(() => readContextArtifact(root, "private/dir/up/a.txt"), "link_rejected");
		expectCode(() => readContextArtifact(root, "private/none.txt"), "not_found");
		expectCode(() => readContextArtifact(root, "private"), "not_a_file");
		expectCode(() => readContextArtifact(root, ref, 4), "too_large");
	});
});

describe("catalog construction", () => {
	it("builds a deterministic private catalog with workspace-qualified relationships", () => {
		const first = setup();
		const meeting = first.catalog.meetings[0]!;
		expect(first.catalog).toMatchObject({ schemaVersion: 1, workspaceId: "ws-synthetic", owner: OWNER });
		expect(meeting.annotation).toMatchObject({ revision: 1, projects: [GARDEN, WORKSTREAM] });
		expect(meeting.artifacts.map((artifact) => [artifact.artifactId, artifact.kind, artifact.state])).toEqual([
			[`transcript/${key("m1")}`, "transcript", "available"],
			[`provider-summary/${key("m1")}`, "provider-summary", "available"],
			["attachment/slides", "attachment", "available"],
		]);
		expect(first.catalog.meetings[1]?.annotation.projects).toEqual([]);
		// Same inputs in a different root produce the same generation: no paths or random IDs leak in.
		expect(catalogGeneration(setup().catalog)).toBe(catalogGeneration(first.catalog));
	});

	it("rejects ambiguous, unknown or inconsistent review input", () => {
		const base = setup();
		const build = (reviews: ReadonlyArray<MeetingReview>, overrides: Record<string, unknown> = {}) =>
			buildMeetingCatalog({
				contextRoot: base.root,
				workspace: WORKSPACE,
				owner: OWNER,
				retention: SYNTHETIC_RETENTION,
				inventory: base.inventory,
				reviews,
				...overrides,
			});
		const one = { meetingId: "mtg_m001", sourceKeys: [key("m1")], title: "One", projects: [] };
		expect(build([one]).meetings).toHaveLength(1);
		expectCode(
			() => build([one], { inventory: { ...base.inventory, status: "incomplete" } }),
			"incomplete_inventory",
		);
		expectCode(() => build([{ ...one, meetingId: "MTG" }]), "invalid_input");
		expectCode(() => build([one, { ...one, sourceKeys: [key("m2")] }]), "invalid_input");
		expectCode(() => build([{ ...one, sourceKeys: [] }]), "invalid_input");
		expectCode(() => build([{ ...one, sourceKeys: [key("m9")] }]), "invalid_input");
		expectCode(() => build([one, { ...one, meetingId: "mtg_dupe" }]), "invalid_input");
		expectCode(() => build([{ ...one, projects: ["other-ws/garden"] }]), "invalid_input");
		expectCode(() => build([{ ...one, projects: [GARDEN, GARDEN] }]), "invalid_input");
		expectCode(() => build([{ ...one, title: "" }]), "invalid_input");
		expectCode(() => build([{ ...one, legacyRefs: ["../note.md"] }]), "path_rejected");
		expect(build([{ ...one, legacyRefs: ["b.md", "a.md"] }]).meetings[0]?.legacyRefs).toEqual(["a.md", "b.md"]);
		expectCode(
			() =>
				build([
					{
						...one,
						attachments: [
							{ name: "slides", ref: "private/owner/attachments/slides.txt" },
							{ name: "slides", ref: "private/owner/attachments/slides.txt" },
						],
					},
				]),
			"invalid_input",
		);
		expectCode(() => build([{ ...one, attachments: [{ name: "x", ref: "private/none.txt" }] }]), "not_found");
		expectCode(
			() =>
				build([
					{
						...one,
						decisions: [
							{ text: "D", citation: { artifactId: `transcript/${key("m1")}`, sourceRevision: 1, segment: 3 } },
						],
					},
				]),
			"invalid_input",
		);
		expectCode(
			() =>
				build([
					{
						...one,
						decisions: [
							{
								text: "D",
								citation: { artifactId: `provider-summary/${key("m1")}`, sourceRevision: 1, segment: 0 },
							},
						],
					},
				]),
			"invalid_input",
		);
		expectCode(
			() =>
				build([
					{
						...one,
						decisions: [
							{
								text: "D",
								citation: { artifactId: `transcript/${key("m1")}`, sourceRevision: 1, segment: 0.5 },
							},
						],
					},
				]),
			"invalid_input",
		);
		expectCode(
			() =>
				build([
					{
						...one,
						decisions: [
							{ text: "D", citation: { artifactId: `transcript/${key("m1")}`, sourceRevision: 1, segment: -1 } },
						],
					},
				]),
			"invalid_input",
		);
		expectCode(
			() => build([one], { retention: { policy: "retain-source-artifacts", deletesSourceArtifacts: true } }),
			"invalid_input",
		);
		expectCode(
			() => build([one], { retention: { policy: "expire-90d", deletesSourceArtifacts: false } }),
			"invalid_input",
		);
		expectCode(() => build([one], { owner: " " }), "invalid_input");
	});

	it("refuses a source retained twice until it is reviewed explicitly", () => {
		const root = createContextRoot();
		writeEnvelope(root, "twice", { bucket: "pending" });
		writeEnvelope(root, "twice", { bucket: "processed" });
		const inventory = collectMeetingInventory({ contextRoot: root, roots: ROOTS, accountScopes: SCOPES });
		expectCode(
			() =>
				buildMeetingCatalog({
					contextRoot: root,
					workspace: WORKSPACE,
					owner: OWNER,
					retention: SYNTHETIC_RETENTION,
					inventory,
					reviews: [],
				}),
			"invalid_input",
		);
	});
});

describe("trusted synthetic membership", () => {
	it("issues principals only from the current table", () => {
		const membership = new TrustedSyntheticMembership(TABLE, WORKSPACE);
		expect(membership.authenticate("nobody@example.test")).toBeNull();
		expect(membership.authenticate(OWNER)).toMatchObject({ id: OWNER, teams: [], membershipRevision: 1 });
		expect(membership.authenticate("gina@example.test")?.teams).toEqual(["garden"]);
		expect(Object.isFrozen(membership.authenticate("gina@example.test"))).toBe(true);
		expect(membership.teamProjects("missing").size).toBe(0);
		expectCode(() => membership.revise(TABLE, WORKSPACE), "invalid_input");
		expect(membership.revise({ ...TABLE, revision: 2 }, WORKSPACE).revision).toBe(2);
		expectCode(() => new TrustedSyntheticMembership({ ...TABLE, revision: 0 }, WORKSPACE), "invalid_input");
		expectCode(() => new TrustedSyntheticMembership({ ...TABLE, revision: 1.5 }, WORKSPACE), "invalid_input");
		expectCode(
			() =>
				new TrustedSyntheticMembership(
					{ ...TABLE, teams: { "Bad Team": { projects: [], members: [] } } },
					WORKSPACE,
				),
			"invalid_input",
		);
		expectCode(
			() =>
				new TrustedSyntheticMembership(
					{ ...TABLE, teams: { t: { projects: ["garden"], members: [] } } },
					WORKSPACE,
				),
			"invalid_input",
		);
		expectCode(
			() => new TrustedSyntheticMembership({ ...TABLE, teams: { t: { projects: [], members: [""] } } }, WORKSPACE),
			"invalid_input",
		);
	});
});

describe("owner-controlled access policy", () => {
	it("grants exact artifact revisions and revokes them with independent policy revisions", () => {
		const { catalog, membership, owner } = setup();
		const grant = { team: "garden", meetingId: "mtg_m001", artifactId: `transcript/${key("m1")}`, sourceRevision: 1 };
		const policy = grantArtifactAccess({
			catalog,
			membership,
			principal: owner,
			policy: emptyAccessPolicy(catalog),
			grant,
		});
		expect(policy).toMatchObject({ revision: 1, owner: OWNER, grants: [grant] });
		expect(grantArtifactAccess({ catalog, membership, principal: owner, policy, grant })).toBe(policy);
		const revoked = revokeArtifactAccess({ catalog, membership, principal: owner, policy, grant });
		expect(revoked).toMatchObject({ revision: 2, grants: [] });
		expect(revokeArtifactAccess({ catalog, membership, principal: owner, policy: revoked, grant })).toBe(revoked);

		const gina = membership.authenticate("gina@example.test")!;
		expectCode(() => grantArtifactAccess({ catalog, membership, principal: gina, policy, grant }), "not_authorized");
		const forged = { id: OWNER, teams: [], membershipRevision: 1 };
		expectCode(
			() => grantArtifactAccess({ catalog, membership, principal: forged, policy, grant }),
			"not_authorized",
		);
		const successor = membership.revise({ ...TABLE, revision: 2 }, WORKSPACE);
		expectCode(
			() => revokeArtifactAccess({ catalog, membership: successor, principal: owner, policy, grant }),
			"not_authorized",
		);
		const foreignOwner = new TrustedSyntheticMembership(
			{ ...TABLE, owner: "other@example.test", teams: { garden: { projects: [], members: [OWNER] } } },
			WORKSPACE,
		);
		expectCode(
			() =>
				grantArtifactAccess({
					catalog,
					membership: foreignOwner,
					principal: foreignOwner.authenticate(OWNER)!,
					policy,
					grant,
				}),
			"not_authorized",
		);
		expectCode(
			() => grantArtifactAccess({ catalog, membership, principal: owner, policy: { ...policy, owner: "x" }, grant }),
			"invalid_input",
		);
		expectCode(
			() =>
				grantArtifactAccess({ catalog, membership, principal: owner, policy, grant: { ...grant, team: "life" } }),
			"invalid_input",
		);
		expectCode(
			() =>
				grantArtifactAccess({
					catalog,
					membership,
					principal: owner,
					policy,
					grant: { ...grant, sourceRevision: 2 },
				}),
			"invalid_input",
		);
		expectCode(
			() =>
				grantArtifactAccess({
					catalog,
					membership,
					principal: owner,
					policy,
					grant: { ...grant, meetingId: "mtg_none" },
				}),
			"invalid_input",
		);
	});
});

describe("annotations", () => {
	it("advance only their own revision and reject divergent edits", () => {
		const { catalog, membership, owner } = setup();
		const change = { meetingId: "mtg_m001", baseRevision: 1 };
		const titled = annotateMeeting({
			catalog,
			membership,
			principal: owner,
			workspace: WORKSPACE,
			change: { ...change, title: "Renamed" },
		});
		const meeting = titled.meetings[0]!;
		expect(meeting.annotation).toMatchObject({ revision: 2, title: "Renamed", projects: [GARDEN, WORKSTREAM] });
		expect(meeting.sourceRevision).toBe(1);
		const cleared = annotateMeeting({
			catalog: titled,
			membership,
			principal: owner,
			workspace: WORKSPACE,
			change: {
				meetingId: "mtg_m001",
				baseRevision: 2,
				title: null,
				projects: [LIFE],
				decisions: [
					{ text: "Ship", citation: { artifactId: `transcript/${key("m1")}`, sourceRevision: 1, segment: 2 } },
				],
			},
		});
		expect(cleared.meetings[0]?.annotation).toMatchObject({ revision: 3, title: null, projects: [LIFE] });
		expect(cleared.meetings[0]?.annotation.decisions).toHaveLength(1);
		expect(cleared.meetings[1]).toBe(catalog.meetings[1]);
		const moved = annotateMeeting({
			catalog: cleared,
			membership,
			principal: owner,
			workspace: WORKSPACE,
			change: { meetingId: "mtg_m001", baseRevision: 3, projects: [] },
		});
		expect(moved.meetings[0]?.annotation).toEqual({ ...cleared.meetings[0]?.annotation, revision: 4, projects: [] });
		expectCode(
			() => annotateMeeting({ catalog: titled, membership, principal: owner, workspace: WORKSPACE, change }),
			"annotation_conflict",
		);
		expectCode(
			() =>
				annotateMeeting({
					catalog,
					membership,
					principal: owner,
					workspace: WORKSPACE,
					change: { ...change, meetingId: "mtg_none" },
				}),
			"invalid_input",
		);
		expectCode(
			() =>
				annotateMeeting({
					catalog,
					membership,
					principal: membership.authenticate("gina@example.test")!,
					workspace: WORKSPACE,
					change,
				}),
			"not_authorized",
		);
	});
});

describe("query bounds", () => {
	it("validates limits and reports truncation over visible meetings only", () => {
		const { root, catalog, membership, owner } = setup();
		const policy = emptyAccessPolicy(catalog);
		const one = queryMeetingContext({ catalog, policy, membership, principal: owner, limit: 1 });
		expect(one.ok && one.packet.bounds).toEqual({ limit: 1, returned: 1, truncated: true });
		const all = queryMeetingContext({ catalog, policy, membership, principal: owner });
		expect(all.ok && all.packet.bounds).toEqual({ limit: 20, returned: 2, truncated: false });
		for (const limit of [0, 201, 1.5])
			expectCode(
				() => queryMeetingContext({ catalog, policy, membership, principal: owner, limit }),
				"invalid_input",
			);
		expect(queryMeetingContext({ catalog, policy: { ...policy, owner: "x" }, membership, principal: owner })).toEqual(
			{
				ok: false,
				reason: "stale_authorization",
			},
		);
		expect(
			retrieveMeetingArtifact({
				contextRoot: root,
				catalog,
				policy: { ...policy, owner: "x" },
				membership,
				principal: owner,
				meetingId: "mtg_m001",
				artifactId: "attachment/slides",
				sourceRevision: 1,
			}),
		).toEqual({ ok: false, reason: "stale_authorization" });
	});
});
