import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { WikiPassage, WikiSourceVersion } from "@harnessy/core/wiki";

const MAX_BYTES = 12 * 1024 * 1024;
const privateNetworks = new BlockList();
const privateV6Networks = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 3],
] as const)
	privateNetworks.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
	["::", 96],
	["::ffff:0:0", 96],
	["64:ff9b::", 96],
	["100::", 64],
	["2001::", 23],
	["2002::", 16],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const)
	privateV6Networks.addSubnet(network, prefix, "ipv6");

export const isPublicAddress = (address: string): boolean => {
	const family = isIP(address);
	return family === 4
		? !privateNetworks.check(address, "ipv4")
		: family === 6 && !privateV6Networks.check(address, "ipv6");
};

export interface Download {
	readonly bytes: Buffer;
	readonly contentType: string;
	readonly url: string;
	readonly status: number;
}

/** Resolve and validate every hop, then pin the TCP connection to that address.
 * The loopback fixture seam is explicit and is never exposed by the CLI. */
export async function download(raw: string, signal: AbortSignal, fixtureOrigin?: string): Promise<Download> {
	let url = new URL(raw);
	for (let hop = 0; hop < 6; hop++) {
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
			throw new Error("Unsupported or credential-bearing public URL");
		const host = url.hostname.replace(/^\[|\]$/g, "");
		const addresses = await lookup(host, { all: true });
		const fixture = fixtureOrigin === url.origin && (host === "127.0.0.1" || host === "::1");
		if (!addresses.length || (!fixture && addresses.some((item) => !isPublicAddress(item.address))))
			throw new Error("Private-network destination rejected");
		const address = addresses[0];
		if (!address) throw new Error("No public address");
		const result = await new Promise<Download & { location?: string }>((resolve, reject) => {
			const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
				url,
				{
					signal,
					agent: false,
					lookup: (_host, _options, callback) => callback(null, address.address, address.family),
					headers: {
						"User-Agent": "Harnessy-Personal-Library/1.0",
						Accept: "text/html,application/pdf,text/plain,text/markdown",
						"Accept-Encoding": "identity",
					},
				},
				(response) => {
					const status = response.statusCode ?? 0;
					if (status >= 300 && status < 400) {
						response.destroy();
						resolve({
							bytes: Buffer.alloc(0),
							contentType: "",
							url: url.href,
							status,
							location: response.headers.location,
						});
						return;
					}
					if (Number(response.headers["content-length"] ?? 0) > MAX_BYTES) {
						response.destroy();
						reject(new Error("Source exceeds download limit"));
						return;
					}
					let size = 0;
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > MAX_BYTES) response.destroy(new Error("Source exceeds download limit"));
						else chunks.push(chunk);
					});
					response.on("error", reject);
					response.on("end", () =>
						resolve({
							bytes: Buffer.concat(chunks),
							contentType: response.headers["content-type"] ?? "",
							url: url.href,
							status,
						}),
					);
				},
			);
			request.setTimeout(30_000, () => request.destroy(new Error("Source download timeout")));
			request.on("error", reject);
			request.end();
		});
		if (result.status < 300 || result.status >= 400) return result;
		if (!result.location) throw new Error("Redirect missing location");
		url = new URL(result.location, url);
	}
	throw new Error("Too many source redirects");
}

const decode = (text: string): string =>
	text
		.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
			const n = code[0]?.toLowerCase() === "x" ? Number.parseInt(code.slice(1), 16) : Number(code);
			return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
		})
		.replace(
			/&(?:amp|lt|gt|quot|apos|nbsp);/g,
			(entity) =>
				({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " })[entity] ?? entity,
		);

export function htmlEvidence(html: string): { text: string; mode: WikiSourceVersion["mode"] } {
	const abstract =
		[...html.matchAll(/<meta\b[^>]*>/gi)]
			.map((match) => {
				const tag = match[0];
				if (
					!/(?:name|property)\s*=\s*["'](?:citation_abstract|dc\.description|description|og:description)["']/i.test(
						tag,
					)
				)
					return "";
				return decode(tag.match(/content\s*=\s*(["'])([\s\S]*?)\1/i)?.[2] ?? "");
			})
			.find(Boolean) ?? "";
	const clean = html.replace(/<(script|style|nav|header|footer|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
	const article = clean.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)\s*>/i)?.[1];
	const body = article ?? clean.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, "");
	const text = decode(body.replace(/<\/(?:p|div|h[1-6]|li|section)>/gi, "\n\n").replace(/<[^>]+>/g, " "))
		.replace(/[ \t]+/g, " ")
		.trim();
	if (
		(!article && text.length < 800) ||
		/(?:access denied|subscribe to (?:read|continue)|sign in to (?:read|continue)|just a moment|enable javascript)/i.test(
			text.slice(0, 3000),
		)
	) {
		if (abstract) return { text: abstract, mode: "abstract" };
		throw new Error("Unavailable or access-restricted HTML; no usable abstract");
	}
	return { text, mode: "full" };
}

export function passages(text: string, prefix = "passage"): WikiPassage[] {
	const result: WikiPassage[] = [];
	for (const paragraph of text
		.replaceAll("\0", "")
		.slice(0, 240_000)
		.split(/\n\s*\n/)) {
		for (let offset = 0; offset < paragraph.length; offset += 1800) {
			const value = paragraph.slice(offset, offset + 1800).trim();
			if (value) result.push({ locator: `${prefix}-${result.length + 1}`, text: value });
		}
	}
	return result;
}

export async function extract(
	uri: string,
	signal: AbortSignal,
	fixtureOrigin?: string,
): Promise<{ bytes: Buffer; mode: WikiSourceVersion["mode"]; passages: WikiPassage[] }> {
	let bytes: Buffer;
	let contentType: string;
	if (/^https?:/i.test(uri)) {
		const response = await download(uri, signal, fixtureOrigin);
		if (response.status < 200 || response.status >= 300)
			throw new Error(`Source unavailable: HTTP ${response.status}`);
		bytes = response.bytes;
		contentType = response.contentType;
	} else {
		if ((await stat(uri)).size > MAX_BYTES) throw new Error("Source exceeds file limit");
		bytes = await readFile(uri);
		contentType =
			extname(uri).toLowerCase() === ".pdf"
				? "application/pdf"
				: [".md", ".txt"].includes(extname(uri).toLowerCase())
					? "text/plain"
					: "unsupported";
	}
	if (signal.aborted) throw new Error("Extraction cancelled");
	if (bytes.length > MAX_BYTES) throw new Error("Source exceeds file limit");
	if (bytes.subarray(0, 5).toString() === "%PDF-" || contentType.includes("application/pdf")) {
		const directory = await mkdtemp(join(tmpdir(), "harnessy-pdf-"));
		try {
			const input = join(directory, "source.pdf");
			await writeFile(input, bytes, { mode: 0o600 });
			const text = await new Promise<string>((resolve, reject) =>
				execFile(
					"pdftotext",
					["-layout", "-enc", "UTF-8", input, "-"],
					{ signal, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
					(error, stdout) =>
						error
							? reject(new Error(`PDF extraction failed (requires pdftotext): ${error.message}`))
							: resolve(stdout),
				),
			);
			const extracted = text.split("\f").flatMap((page, i) => passages(page, `page-${i + 1}-passage`));
			if (!extracted.length) throw new Error("Unsupported scanned PDF: no text layer; OCR is not enabled");
			return { bytes, mode: "full", passages: extracted };
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
	if (contentType.includes("html")) {
		const result = htmlEvidence(bytes.toString("utf8"));
		return { bytes, mode: result.mode, passages: passages(result.text) };
	}
	if (!contentType.startsWith("text/")) throw new Error(`Unsupported source content type: ${contentType}`);
	const extracted = passages(bytes.toString("utf8"));
	if (!extracted.length) throw new Error("No usable source text");
	return { bytes, mode: "full", passages: extracted };
}
