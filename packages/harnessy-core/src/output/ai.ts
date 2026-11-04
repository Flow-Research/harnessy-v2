import type { AiResolution } from "../ai/runner.ts";

import { renderStructuredJson } from "./json.ts";

/** Render the stable structured JSON text for `harnessy ai resolve --json`. */
export const renderAiResolutionJson = (resolution: AiResolution): string =>
	renderStructuredJson({
		command: "ai-resolve",
		ok: true,
		single: resolution.single,
		providerOrder: resolution.providerOrder,
		resolved: resolution.resolved.map((entry) => ({ provider: entry.provider, model: entry.model })),
	});
