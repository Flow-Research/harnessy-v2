import { Layer } from "effect";
import { JarvisConfigReader } from "../../src/jarvis/config.ts";
import { JarvisCredentialResolver } from "../../src/jarvis/credentials.ts";
import { JarvisDiagnostic } from "../../src/jarvis/diagnostic.ts";
import { JarvisParityReporter } from "../../src/jarvis/parity-report.ts";
import { JarvisPathResolver } from "../../src/jarvis/paths.ts";

/** Root CLI types include every branch. Unselected services must never run in
 * these tests. Selected Jarvis commands supply their real fixture layers closer
 * to the invocation; an accidental call to any remaining mock fails the test. */
export const unselectedCliServices = Layer.mergeAll(
	Layer.mock(JarvisConfigReader, {}),
	Layer.mock(JarvisCredentialResolver, {}),
	Layer.mock(JarvisDiagnostic, {}),
	Layer.mock(JarvisParityReporter, {}),
	Layer.mock(JarvisPathResolver, {}),
);
