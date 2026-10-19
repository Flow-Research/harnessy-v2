/**
 * What `executor server rotate-token` prints. The new token is a secret: it
 * is written owner-only to auth.json and never printed, so it does not end up
 * in terminal scrollback, shell logs or CI output. The report says where it
 * is and what to restart.
 */
export const rotateTokenReport = (input: {
  readonly tokenPath: string;
  readonly runningServer: { readonly origin: string; readonly pid: number } | null;
  readonly cliPrefix: string;
}): ReadonlyArray<string> => [
  "Rotated the local server bearer token.",
  `Stored owner-only in ${input.tokenPath} (not printed).`,
  ...(input.runningServer === null
    ? []
    : [
        "",
        `A local server is running at ${input.runningServer.origin} (pid ${input.runningServer.pid}).`,
        "Restart it to apply the new token.",
      ]),
  "",
  `Reconnect MCP clients with the new token from that file, and sign the web UI in again with \`${input.cliPrefix} open\`.`,
];
