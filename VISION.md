# Harnessy core and Garden CLI direction

Status: agreed direction with staged implementation. This document does not
establish that a proposed capability is installed, deployed or accepted.

This repository is the canonical source for Harnessy's core and local runtime.
The intended user-facing destination is Garden CLI. Keep the current `harnessy`,
`hsy` and `jarvis` commands during that transition. Command, package and state-path
changes need a separate compatibility plan. Do not create a second CLI runtime.
See [the canonical-source decision](docs/adr/0004-harnessy-v2-is-canonical.md)
and the [technical roadmap](.jarvis/context/roadmap.md).

The original V1 repository is recovery material. Reuse verified V1 behavior
through the existing compatibility capability package. Do not restart V1 services.

## Product and authority boundaries

| Component | Responsibility |
| --- | --- |
| Harnessy core | Stable contracts, scoped authority, validated dispatch, installation lifecycle, state ownership and audit boundaries |
| Capability package | Bounded domain operations, schemas, resources, dependencies, requested permissions and host-rendered UI declarations |
| Host adapter | Storage, credentials, networking, notifications, process access and service lifecycle for a declared environment |
| Garden | Workspace and member authority, installation controls, approvals, client experience and connected-host selection |
| WorkStream | Canonical task, submission, evaluation, Review, acceptance and contribution records under project-owned policy |
| Jarvis | Knowledge and personal workflows, plus an agreed export mapping for contribution evidence; export does not block payment |
| Pi and Executor foundations | Agent/model execution and existing connector, credential, policy, approval and audit mechanisms behind explicit host boundaries |

The core enforces the rules under which a capability operates. Permission
declarations do not grant authority. Keep domain operations replaceable without
letting a plugin replace host identity, permission or audit rules. Reuse current
capability and Executor contracts before adding an abstraction. Ordinary
in-process plugin loading does not provide isolation.

Distinguish a reusable domain capability, an executable tool, an instruction or
skill pack, a connector and a host integration in their owning contracts. Neither
Harnessy export nor Garden capability discovery proves installation across hosts.

## First shared capability

Use the contribution workflow as the first complete shared-plugin journey:

1. An authorized Garden member installs an exact package version and grants
   explicit permissions.
2. The member connects an authorized WorkStream account/project, selects an
   enrolled host and registered repository, and reviews agent, budget and
   permission choices.
3. Garden launches the run directly. A copied command alone is insufficient.
4. Harnessy validates scoped authority and creates one isolated worktree and one
   agent run on the selected host.
5. Garden shows status, failures, intervention, cancellation and proof.
   WorkStream retains authoritative work and acceptance records.

Prove the same capability contract in standalone Harnessy and Garden. Other
ecosystem applications can use it through suitable host adapters. Repository
review/merge, contribution acceptance and payment retain their separate rules.
An earned points award is not evidence of cash payment.

The first release must support outside executable plugins with enforced
isolation and permissions. A Flow-only catalogue is insufficient. Pin versions
and digests, check compatibility, and isolate discovery, schema collection and
invocation. Specify credential/network access, resource limits, audit attribution,
revocation, update, rollback and uninstall. Keep shared contracts independent of
React, Node services and Cloudflare bindings.

Initially, plugins can declare host-rendered forms, actions and status cards.
Arbitrary third-party frontend code and custom plugin screens are later work.

## Clients and execution hosts

Garden's client roadmap covers desktop web, mobile web, iOS, Android and native
desktop. The first mobile scope is chat, tasks, approvals, launch and run status.
Evaluate macOS, Windows and Linux together for native desktop. Packaged web UI
is acceptable with proper native sign-in, secure storage, notifications, deep
links and lifecycle support. No framework is selected here. The targets need not
ship at the same time.

Separate client surface, execution host, execution runtime and user choices.
A native phone client is not automatically an on-device coding-agent host.
Start offline support with private cached reads and drafts. Require reconnection
and fresh authority before actions. Keep disconnection, terminal detachment,
cancellation and exact conversation recovery separate.

## Delivery and evidence

Close installed source gaps without downgrading state. Continue proof verification
and first-payment work alongside core/plugin and client delivery. Use bounded
ecosystem contributions as repository readiness, approvals and budgets permit.

Distinguish implemented source, merged source, installed software, live acceptance
and proposed work. Require host conformance, hostile-plugin isolation, tenant
separation, revocation, upgrade/rollback, duplicate-launch and uncertain-delivery
tests. Every claimed native target also needs physical-device and native lifecycle
evidence. Browser emulation alone does not establish native support.

Preserve commands, repository mappings, credentials, services and user state during
migration. Never claim an external write, merge, acceptance or payment without
evidence from its owning authority.
