/**
 * Process entry for the hosted task service.
 *
 * Environment:
 * - TASKS_FILE (default: /data/tasks.json)
 * - TASKS_AUTH_TOKEN or TASKS_TOKEN_FILE (mode 0600; the value is never logged)
 * - PORT (default: 8787)
 * - HOST (default: 0.0.0.0)
 */

import { loadTasksAuthToken, startTasksHttpServer, TASKS_SERVICE_PORT } from "./http.ts";
import { defaultTasksFile } from "./store.ts";

const file = process.env.TASKS_FILE?.trim() || defaultTasksFile("/data");
const host = process.env.HOST?.trim() || "0.0.0.0";
const port = Number(process.env.PORT ?? TASKS_SERVICE_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
	console.error("invalid_port");
	process.exit(1);
}

const token = loadTasksAuthToken();
const server = await startTasksHttpServer({ file, token, host, port });
console.log(`tasks-service listening on ${server.url}`);
