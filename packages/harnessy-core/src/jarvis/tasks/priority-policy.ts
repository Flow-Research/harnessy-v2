export const priorityPolicy = {
	waitingDecisionInMine: true,
	candidateState: "review",
	batchConfirmation: "preview-hash",
	manualConfirmation: "page-session",
	scopeResetDays: 7,
	reopenedLastOnTie: true,
} as const;
