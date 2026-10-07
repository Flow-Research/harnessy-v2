/** Portable personal-knowledge contracts. Evidence is data, never an instruction. */
export interface WikiCitation {
	readonly versionId: string;
	readonly locator: string;
	readonly quote: string;
}

export interface WikiPassage {
	readonly locator: string;
	readonly text: string;
}

export interface WikiSource {
	readonly id: string;
	readonly identity: string;
	readonly uri: string;
	readonly title: string;
	readonly topics: readonly string[];
	readonly manualTopics: boolean;
	readonly capturedAt: string;
	readonly status: "pending" | "processed" | "failed";
	readonly error: string | null;
	readonly currentVersion: string | null;
}

export interface WikiSourceVersion {
	readonly id: string;
	readonly sourceId: string;
	readonly contentHash: string;
	readonly fetchedAt: string;
	readonly mode: "full" | "abstract" | "metadata";
	readonly passages: readonly WikiPassage[];
}

export interface WikiClaim {
	readonly text: string;
	readonly kind: "finding" | "agreement" | "disagreement" | "connection" | "implication" | "question" | "gap";
	readonly citations: readonly WikiCitation[];
}

export interface WikiPageProposal {
	readonly path: string;
	readonly title: string;
	readonly topics: readonly string[];
	readonly claims: readonly WikiClaim[];
	readonly links: readonly string[];
}

export interface WikiSynthesisResult {
	readonly pages: readonly WikiPageProposal[];
}

export interface WikiEvidence {
	readonly source: WikiSource;
	readonly version: WikiSourceVersion;
}

export interface WikiModelRequest {
	readonly task: "compile" | "ask" | "review";
	readonly instruction: string;
	readonly evidence: readonly WikiEvidence[];
	readonly pages: readonly { readonly path: string; readonly markdown: string }[];
	readonly topics: readonly string[];
}

export type WikiExecutor = (request: WikiModelRequest, signal: AbortSignal) => Promise<unknown>;

export { classifyFailure, providerOrder, resolveProviderModel } from "./ai/runner.ts";
export { resolveLifeOrchestratorSettings } from "./jarvis/life-orchestrator/config.ts";
export { scanDeliveredLifeBriefs } from "./jarvis/life-orchestrator/history.ts";
export { canonicalizeReadingUrl, readingIdentity } from "./jarvis/life-orchestrator/identity.ts";
export { parseLifeResearchTopics } from "./jarvis/life-orchestrator/research.ts";
