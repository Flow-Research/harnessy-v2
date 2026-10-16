import { resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { JarvisMeetingPublicationConfig } from "../config-model.ts";
import {
	MeetingPublicationWriteAuthority,
	type MeetingPublicationWriteAuthorityCode,
	MeetingPublicationWriteAuthorityError,
	MeetingPublicationWriteAuthorityState,
	MeetingPublicationWriteBinding,
	type MeetingPublicationWriteOperation,
} from "./authority.ts";
import { issueMeetingPublicationWriteGrantForTest } from "./authority-grant-registry.ts";

const bindingForTest = (config: JarvisMeetingPublicationConfig): MeetingPublicationWriteBinding | null => {
	if (
		config.sourcePath === null ||
		config.sourcePath.trim().length === 0 ||
		config.statePath === null ||
		config.statePath.trim().length === 0
	) {
		return null;
	}
	return Object.freeze(
		new MeetingPublicationWriteBinding({
			sourcePath: resolve(config.sourcePath),
			statePath: resolve(config.statePath),
		}),
	);
};

const sameBinding = (left: MeetingPublicationWriteBinding, right: MeetingPublicationWriteBinding) =>
	left.sourcePath === right.sourcePath && left.statePath === right.statePath;

/**
 * Source-level test fixture. This file is intentionally absent from every Core
 * package export and must never be used as an operational authority.
 */
export const meetingPublicationTestWriteAuthorityLayer = (
	config: JarvisMeetingPublicationConfig,
	options: {
		readonly isActive?: () => boolean;
		readonly allows?: (operation: MeetingPublicationWriteOperation) => boolean;
		readonly onAuthorize?: (operation: MeetingPublicationWriteOperation) => void;
	} = {},
) => {
	const expected = bindingForTest(config);
	const isActive = options.isActive ?? (() => true);
	const allows = options.allows ?? (() => true);
	const codeFor = (
		binding: MeetingPublicationWriteBinding | null,
		operation: MeetingPublicationWriteOperation,
	): MeetingPublicationWriteAuthorityCode => {
		if (binding === null || expected === null) return "missing_binding";
		if (!sameBinding(binding, expected)) return "binding_mismatch";
		return isActive() && allows(operation) ? "authorized" : "revoked";
	};
	return Layer.succeed(
		MeetingPublicationWriteAuthority,
		MeetingPublicationWriteAuthority.of({
			authorize: (operation, binding) => {
				options.onAuthorize?.(operation);
				const code = codeFor(binding, operation);
				if (code !== "authorized") {
					return Effect.fail(new MeetingPublicationWriteAuthorityError({ operation, code }));
				}
				return Effect.succeed(
					issueMeetingPublicationWriteGrantForTest(operation, binding, {
						validate: (issuedOperation, issuedBinding) =>
							Effect.succeed(codeFor(issuedBinding, issuedOperation) === "authorized"),
					}),
				);
			},
			state: (binding) => {
				const code = codeFor(binding, "service_worker");
				return Effect.succeed(
					new MeetingPublicationWriteAuthorityState({
						owner: "v2_test",
						authorized: code === "authorized",
						code,
					}),
				);
			},
		}),
	);
};
