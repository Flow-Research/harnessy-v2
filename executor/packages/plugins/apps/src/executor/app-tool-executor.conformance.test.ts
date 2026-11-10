// oxlint-disable-next-line executor/no-vitest-import -- Cloudflare pool requires Vitest 4; Effect adapter requires Vitest 5.
import { describe, it } from "vitest";

import { makeInProcessAppToolExecutor } from "./app-tool-executor";
import { isWorkerdAvailable, makeWorkerdAppToolExecutor } from "./workerd-app-tool-executor";
import { appToolExecutorConformance } from "../testing/conformance";

appToolExecutorConformance("in-process", makeInProcessAppToolExecutor);

if (isWorkerdAvailable()) {
  appToolExecutorConformance("workerd", makeWorkerdAppToolExecutor);
} else {
  describe("workerd app tool executor conformance", () => {
    it.skip("skipped because the workerd binary is unavailable on this platform", () => {});
  });
}
