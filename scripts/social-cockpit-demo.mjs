import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { startServer } from "../executor/apps/local/src/serve.ts";

// The demo always uses its own profile, scope, operator credential, and fixture adapters.
if (!process.stdin.isTTY || !process.stdout.isTTY)
  throw new Error("Run the fixture demo in a private interactive terminal.");
if (!existsSync(fileURLToPath(new URL("../executor/apps/local/dist/index.html", import.meta.url))))
  throw new Error("Build the local cockpit first with npm run build:executor-runtime.");
const profile = fileURLToPath(new URL("../.social-demo/", import.meta.url));
mkdirSync(profile, { mode: 0o700, recursive: true });
const scope = resolve(profile, "workspace");
mkdirSync(scope, { mode: 0o700, recursive: true });
const code = randomBytes(32).toString("base64url");
Object.assign(process.env, {
  EXECUTOR_DATA_DIR: profile,
  EXECUTOR_SCOPE_DIR: scope,
  HARNESSY_SOCIAL_MODE: "fixture",
  HARNESSY_SOCIAL_OPERATOR_CODE: code,
  HARNESSY_SOCIAL_AGENT_TOKEN: randomBytes(32).toString("hex"),
  HARNESSY_SOCIAL_AGENT_ACCOUNTS: "x-fixture,wa-fixture",
});
const server = await startServer({ port: 0, hostname: "127.0.0.1" });
async function showLogin() {
  const response = await fetch(server.origin + "/api/local-auth/code", {
    method: "POST",
    headers: { authorization: "Bearer " + server.authToken },
  });
  if (!response.ok) throw new Error("Local sign-in link unavailable.");
  const ticket = await response.json();
  console.log(
    "Open the one-time sign-in link, then select Social inbox:\n" +
      server.origin +
      "/auth/sign-in#_code=" +
      ticket.code,
  );
  console.log("Enter this operator code on the Social page:\n" + code);
}
await showLogin();
console.log("Press Enter for a new sign-in link, or Ctrl+C to stop.");
const input = createInterface({ input: process.stdin, output: process.stdout });
input.on("line", showLogin);
input.on("SIGINT", () => input.close());
input.on("close", async () => {
  await server.stop();
  process.exit(0);
});
