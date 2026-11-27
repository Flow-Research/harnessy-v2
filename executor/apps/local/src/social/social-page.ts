import { createHash } from "node:crypto";
import { socialDocument as page } from "./social-document";

// Bun embeds this file in the CLI. Only these two static inline blocks can run.
// No provider data or credentials are inserted into the document on the host.
const blockHash = (tag: "style" | "script") => {
  const start = page.indexOf(`<${tag}>`) + tag.length + 2;
  const end = page.indexOf(`</${tag}>`, start);
  return `'sha256-${createHash("sha256").update(page.slice(start, end)).digest("base64")}'`;
};
const policy = [
  "default-src 'none'",
  `script-src ${blockHash("script")}`,
  `style-src ${blockHash("style")}`,
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const socialPage = (): Response =>
  new Response(page, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": policy,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
