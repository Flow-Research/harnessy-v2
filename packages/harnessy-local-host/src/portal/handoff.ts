/** Fixed destinations for authenticated browser launches. No URL or command comes from the request. */
export const PORTAL_HANDOFF_SERVICES = ["meeting-review", "community-review", "cockpit"] as const;
export type PortalHandoffService = (typeof PORTAL_HANDOFF_SERVICES)[number];

export const handoffTarget = (service: PortalHandoffService): string => `harnessy:open:${service}`;

export const handoffService = (target: string): PortalHandoffService | undefined =>
	PORTAL_HANDOFF_SERVICES.find((service) => handoffTarget(service) === target);
