/**
 * jsdom globals with Node module resolution. The app's end-to-end test renders
 * React in jsdom while it also starts a real portal server over a fixture home,
 * which needs Node built-ins such as `node:sqlite`. Vitest's own `jsdom`
 * environment resolves modules for the browser and cannot load them.
 */
import { builtinEnvironments, type Environment } from "vitest/environments";

const environment: Environment = { ...builtinEnvironments.jsdom, name: "jsdom-ssr", viteEnvironment: "ssr" };

export default environment;
