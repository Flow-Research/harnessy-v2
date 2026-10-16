/**
 * Compatibility entry point for the former plan-mode example.
 *
 * Plan mode now ships as a built-in. Loading this example explicitly is no
 * longer necessary; the re-export keeps existing source imports working.
 */

import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

/**
 * @deprecated Plan mode is built in. This compatibility factory intentionally
 * does nothing so legacy extension paths do not register a second copy.
 */
export function planModeExtension(_pi: ExtensionAPI): void {}

export default planModeExtension;
