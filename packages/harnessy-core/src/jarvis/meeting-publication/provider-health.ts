/** Only bounded, content-free classifications cross into persisted health state. */
export type MeetingProviderFailureKind =
	| "authentication"
	| "identity"
	| "credential_store"
	| "permission"
	| "transient"
	| "other";

export const classifyMeetingProviderFailure = (code: string): MeetingProviderFailureKind => {
	if (["authentication_failed", "reauth_required", "invalid_rapt", "refresh_token_revoked"].includes(code))
		return "authentication";
	if (code === "identity_mismatch") return "identity";
	if (["missing_credential", "credential_store_failed"].includes(code)) return "credential_store";
	if (["permission_denied", "insufficient_scope", "policy_denied"].includes(code)) return "permission";
	if (
		[
			"network_error",
			"timeout",
			"request_timeout",
			"engine_unavailable",
			"provider_unavailable",
			"rate_limited",
		].includes(code)
	)
		return "transient";
	return "other";
};

export const MEETING_AUTH_RECOVERY_ATTEMPT_LIMIT = 5;

export interface MeetingProviderHealth {
	readonly provider: "google" | "discord";
	readonly account: string;
	readonly failure: MeetingProviderFailureKind | null;
	readonly checkedAt: string;
	readonly lastSuccessAt: string | null;
	readonly incidentAt: string | null;
	readonly notifiedAt: string | null;
	readonly recoveryPending: boolean;
}
