import { createHmac, timingSafeEqual } from "node:crypto";
import type { Envelope, SocialAdapter, SocialEvent, Stream, Template } from "../contract";
import {
  accountKey,
  beforeSend,
  equalSecret,
  fail,
  parseObject,
  ProviderHttp,
  record,
  rows,
  str,
  type ProviderFetch,
} from "./transport";

interface WhatsAppConfig {
  wabaId: string;
  phoneId: string;
  token: string;
  appSecret: string;
  verifyToken: string;
  graphVersion: string;
  reads: boolean;
  writes: boolean;
  template?: Template;
  templateConsent: ReadonlySet<string>;
  optOut: ReadonlySet<string>;
}
const digits = (s: string) => /^\d{1,24}$/.test(s);
const recipient = (s: string) => /^[1-9]\d{5,14}$/.test(s);
const callbackRef =
  /^harnessy:([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const media = new Set(["audio", "document", "image", "sticker", "video"]);

export class WhatsAppProvider implements SocialAdapter {
  readonly provider = "whatsapp";
  readonly id: string;
  readonly label: string;
  readonly streams = ["business"] as const;
  private readonly http: ProviderHttp;
  constructor(
    private readonly config: WhatsAppConfig,
    request: ProviderFetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    if (
      !digits(config.wabaId) ||
      !digits(config.phoneId) ||
      !config.token ||
      !config.appSecret ||
      !config.verifyToken ||
      !/^v[1-9]\d*\.0$/.test(config.graphVersion)
    )
      fail(400, "invalid_whatsapp_config");
    if (
      config.template &&
      (config.template.category !== "UTILITY" ||
        !/^[a-z0-9_]+$/.test(config.template.name) ||
        !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(config.template.language) ||
        !config.template.body.trim())
    )
      fail(400, "invalid_template_config");
    this.id = accountKey("whatsapp", config.wabaId + "/" + config.phoneId);
    this.label = "WhatsApp Business · " + config.phoneId;
    this.http = new ProviderHttp(request, clock);
  }
  templates(): readonly Template[] {
    return this.config.template ? [this.config.template] : [];
  }
  verifyChallenge(url: URL): string {
    const token = url.searchParams.get("hub.verify_token") ?? "";
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (
      url.searchParams.get("hub.mode") !== "subscribe" ||
      !equalSecret(token, this.config.verifyToken) ||
      !/^\d{1,64}$/.test(challenge)
    )
      return fail(403, "bad_webhook_challenge");
    return challenge;
  }
  verifyWebhook(raw: Uint8Array, signature: string | null): SocialEvent[] {
    if (!this.config.reads) return fail(503, "live_reads_disabled");
    if (raw.byteLength > 1_048_576) return fail(413, "payload_too_large");
    if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature))
      return fail(403, "bad_webhook_signature");
    const expected = createHmac("sha256", this.config.appSecret).update(raw).digest();
    if (!timingSafeEqual(Buffer.from(signature.slice(7), "hex"), expected))
      return fail(403, "bad_webhook_signature");
    const data = parseObject(new TextDecoder().decode(raw));
    if (data.object !== "whatsapp_business_account" || !Array.isArray(data.entry))
      return fail(400, "wrong_webhook_object");
    const result: SocialEvent[] = [];
    for (const entry of rows(data.entry)) {
      if (entry.id !== this.config.wabaId) return fail(403, "wrong_business_account");
      for (const change of rows(entry.changes)) {
        if (change.field !== "messages") continue;
        const value = record(change.value);
        if (
          record(value.metadata).phone_number_id !== this.config.phoneId ||
          value.messaging_product !== "whatsapp"
        )
          return fail(403, "wrong_phone_number");
        for (const msg of rows(value.messages)) {
          const kind = str(msg.type);
          // Status, system and unsupported events do not renew a customer service window.
          if (kind !== "text" && !media.has(kind)) continue;
          const from = str(msg.from);
          const id = str(msg.id);
          const at = Number(msg.timestamp) * 1000;
          if (
            !recipient(from) ||
            !id ||
            !Number.isSafeInteger(at) ||
            at <= 0 ||
            at > this.clock() + 60_000
          )
            return fail(400, "invalid_webhook_message");
          const part = record(msg[kind]);
          const text = str(kind === "text" ? part.body : part.caption);
          result.push({
            type: "item",
            stream: "business",
            providerId: id,
            threadId: from,
            senderId: from,
            sender: "••••" + from.slice(-4),
            text,
            at: Math.min(at, this.clock()),
            visibility: "private",
            direction: "in",
            attachments:
              media.has(kind) && str(part.id)
                ? [{ id: str(part.id), type: str(part.mime_type) || kind }]
                : [],
            optOut: /^\s*(stop|unsubscribe|opt[ -]?out)\s*[.!]?\s*$/i.test(text),
          });
        }
        for (const item of rows(value.statuses)) {
          const status = item.status === "sent" ? "accepted" : item.status;
          if (
            status !== "accepted" &&
            status !== "delivered" &&
            status !== "read" &&
            status !== "failed"
          )
            continue;
          const id = str(item.id);
          const at = Number(item.timestamp) * 1000;
          if (!id || !Number.isSafeInteger(at) || at <= 0)
            return fail(400, "invalid_webhook_status");
          const attemptRef = callbackRef.exec(str(item.biz_opaque_callback_data))?.[1];
          result.push({
            type: "status",
            providerId: id,
            status,
            at,
            ...(attemptRef ? { attemptRef } : {}),
          });
        }
      }
    }
    return result;
  }
  async check(stream: Stream, cursor: string | null) {
    if (stream !== "business") return fail(400, "unsupported_stream");
    if (!this.config.reads) return fail(403, "live_reads_disabled");
    // Meta delivers new business messages by webhook; there is no history request.
    return { events: [], cursor };
  }
  eligible(env: Envelope): void {
    if (!this.config.writes) return fail(403, "live_writes_disabled");
    if (
      env.accountId !== this.id ||
      !recipient(env.recipient) ||
      !env.text.trim() ||
      !["business", "template"].includes(env.kind)
    )
      return fail(400, "invalid_target");
    if (this.config.optOut.has(env.recipient)) return fail(403, "opted_out");
    if (env.kind === "template") {
      const approved = this.config.template;
      const t = env.template;
      if (!this.config.templateConsent.has(env.recipient)) return fail(403, "consent_required");
      if (!t || !approved || t.name !== approved.name || t.language !== approved.language)
        return fail(403, "template_unavailable");
      const used = new Set<number>();
      const rendered = approved.body.replace(/{{(\d+)}}/g, (_, position: string) => {
        const index = Number(position) - 1;
        used.add(index);
        return t.parameters[index] ?? "";
      });
      if (
        used.size !== t.parameters.length ||
        [...used].some((i) => i < 0 || i >= t.parameters.length) ||
        rendered !== env.text
      )
        return fail(403, "template_content_changed");
    } else if (env.template) return fail(400, "invalid_template");
  }
  private url(resource: string) {
    return new URL(`/${this.config.graphVersion}/${resource}`, "https://graph.facebook.com");
  }
  async send(env: Envelope, recheck?: () => void) {
    this.eligible(env);
    const headers = {
      authorization: "Bearer " + this.config.token,
      "content-type": "application/json",
    };
    const t = env.template;
    let content: Record<string, unknown>;
    if (t) {
      const approved = this.config.template!;
      const lookup = this.url(this.config.wabaId + "/message_templates");
      lookup.searchParams.set("name", t.name);
      lookup.searchParams.set("fields", "name,language,status,category,components");
      lookup.searchParams.set("limit", "100");
      const catalog = await beforeSend(this.http.json(lookup, { headers }, "wa-templates"));
      const matches = rows(catalog.data).filter(
        (row) =>
          row.name === t.name &&
          row.language === t.language &&
          row.category === approved.category &&
          row.status === "APPROVED",
      );
      const components = rows(matches[0]?.components);
      if (
        matches.length !== 1 ||
        components.length !== 1 ||
        components[0]?.type !== "BODY" ||
        components[0].text !== approved.body
      )
        return fail(409, "rejected");
      content = {
        type: "template",
        template: {
          name: t.name,
          language: { code: t.language },
          ...(t.parameters.length
            ? {
                components: [
                  {
                    type: "body",
                    parameters: t.parameters.map((text) => ({ type: "text", text })),
                  },
                ],
              }
            : {}),
        },
      };
    } else
      content = {
        type: "text",
        text: { body: env.text, preview_url: false },
        ...(env.targetId ? { context: { message_id: env.targetId } } : {}),
      };
    recheck?.();
    const response = await this.http.json(
      this.url(this.config.phoneId + "/messages"),
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          messaging_product: "whatsapp",
          ...(env.attemptRef ? { biz_opaque_callback_data: "harnessy:" + env.attemptRef } : {}),
          recipient_type: "individual",
          to: env.recipient,
          ...content,
        }),
      },
      "wa-send",
      true,
    );
    const id = str(rows(response.messages)[0]?.id);
    if (!id) return fail(502, "unknown");
    return { providerId: id };
  }
}
