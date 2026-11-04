/** True when the URL points at the local machine, so sending a local credential is safe. */
export const isLoopbackUrl = (raw: string): boolean => {
	if (!URL.canParse(raw)) return false;
	const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
	return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
};
