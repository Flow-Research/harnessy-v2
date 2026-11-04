import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * The one Codex model every Harnessy default uses. ChatGPT-account Codex
 * rejects the gpt-5.x ids, so a later rename changes only this value or an
 * explicit `--model` / `--draft-model` flag.
 */
export const DEFAULT_CODEX_MODEL = "gpt-6-astra";

/**
 * The pi-ai `openai-codex` entry an id that pi-ai does not list yet is
 * cloned from. Only `id` and `name` change; the transport, base URL, limits
 * and reasoning metadata stay those of this base entry.
 */
export const CODEX_MODEL_BASE_ID = "gpt-5.5";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/** The slice of a pi-ai provider that model resolution reads. */
export interface CodexModelCatalog<TApi extends Api = Api> {
	getModels(): ReadonlyArray<Model<TApi>>;
}

const isCodexModel = <TApi extends Api>(model: Model<TApi> | undefined): model is Model<TApi> =>
	model !== undefined && model.provider === "openai-codex" && model.api === "openai-codex-responses";

/**
 * Resolve a Codex model id. A listed id resolves to pi-ai's own entry;
 * any other well-formed id is the documented base entry with its id
 * overridden. Fails when the id is malformed or the base entry is missing.
 */
export const resolveCodexModel = <TApi extends Api>(
	catalog: CodexModelCatalog<TApi>,
	id: string,
	baseId: string = CODEX_MODEL_BASE_ID,
): Model<TApi> => {
	if (!MODEL_ID.test(id)) throw new Error("Codex model id is invalid.");
	const models = catalog.getModels();
	const known = models.find((candidate) => candidate.id === id);
	if (known !== undefined) {
		if (!isCodexModel(known)) throw new Error("Codex model is not an openai-codex responses model.");
		return known;
	}
	const base = models.find((candidate) => candidate.id === baseId);
	if (!isCodexModel(base)) throw new Error("Codex base model entry is unavailable; no fallback.");
	return Object.freeze({ ...base, id, name: id });
};
