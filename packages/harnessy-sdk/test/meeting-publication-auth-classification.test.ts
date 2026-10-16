import { describe, expect, it } from "vitest";
import { providerErrorFromEngine } from "../src/meeting-publication/providers.ts";

describe("meeting credential failure boundary", () => {
	it("uses Executor's typed reauth signal without persisting the raw message", () => {
		const error = providerErrorFromEngine("google", {
			_tag: "CredentialResolutionError",
			reauthRequired: true,
			message: "sensitive token material",
		});
		expect(error).toMatchObject({ code: "reauth_required", retryable: false });
		expect(JSON.stringify(error)).not.toContain("sensitive");
	});
	it("keeps storage, missing connections, policies and transient failures distinct", () => {
		expect(providerErrorFromEngine("google", { _tag: "CredentialResolutionError" }).code).toBe(
			"credential_store_failed",
		);
		expect(providerErrorFromEngine("google", { _tag: "ConnectionNotFoundError" }).code).toBe("missing_credential");
		expect(providerErrorFromEngine("google", { _tag: "ToolBlockedError" }).code).toBe("policy_denied");
		expect(providerErrorFromEngine("google", { _tag: "StorageError" }).retryable).toBe(true);
	});
});
