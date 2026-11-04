import type { CodeExecutor } from "@executor-js/api/server";
import { Effect } from "effect";

export const fauxHarnessyEngineCodeExecutor: CodeExecutor = {
	execute: () => Effect.succeed({ result: null, output: [], logs: [] }),
};
