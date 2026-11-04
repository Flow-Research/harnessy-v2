import * as sdk from "@1password/sdk";

export type OnePasswordSdkModule = typeof sdk;

// Keep the package import static in this local shim. The service dynamically
// imports this file so normal app boot stays lazy, while Bun's compiler sees
// the concrete @1password/sdk dependency and its sdk-core WASM loader.
export const onePasswordSdk: OnePasswordSdkModule = sdk;
