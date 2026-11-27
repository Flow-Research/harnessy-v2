import { randomUUID } from "node:crypto";
import { validateXTarget } from "./providers/x";
import {
  SocialError,
  type Envelope,
  type SocialAdapter,
  type SocialEvent,
  type Stream,
} from "./contract";

/** Synthetic records use no provider credentials or network transport. */
export function createFixtureAdapters(now: () => number = Date.now): SocialAdapter[] {
  const at = now();
  const send = async (_: Envelope, recheck?: () => void) => {
    recheck?.();
    return { providerId: `fixture-${randomUUID()}` };
  };
  const records: Record<Stream, SocialEvent[]> = {
    mention: [
      {
        type: "item",
        stream: "mention",
        visibility: "public",
        providerId: "101",
        threadId: "101",
        senderId: "82",
        sender: "@Ada",
        text: "What time does the workshop start?",
        at: at - 3000,
      },
    ],
    feed: [
      {
        type: "item",
        stream: "feed",
        visibility: "public",
        providerId: "102",
        threadId: "102",
        senderId: "83",
        sender: "@Workshop",
        text: "The new workshop schedule is ready.",
        at: at - 1000,
      },
    ],
    dm: [
      {
        type: "item",
        stream: "dm",
        providerId: "103",
        threadId: "71-84",
        senderId: "84",
        sender: "@Emeka",
        text: "Can you send my joining details here?",
        at: at - 2000,
      },
    ],
    business: [
      {
        type: "item",
        stream: "business",
        providerId: "wamid.demo",
        threadId: "15550100004",
        senderId: "15550100004",
        sender: "Customer 0004",
        text: "Please confirm my appointment.",
        at: at - 4000,
        attachments: [{ id: "media-demo", type: "image/jpeg", size: 2048 }],
      },
    ],
  };
  const check = async (stream: Stream, cursor: string | null) => ({
    events: cursor ? [] : records[stream],
    cursor: "fixture-seeded",
  });
  return [
    {
      id: "x-fixture",
      provider: "x",
      label: "Workshop on X",
      streams: ["mention", "dm", "feed"],
      pollsNetwork: false,
      check,
      eligible: (env) => validateXTarget(env, "x-fixture", "71"),
      send: async (env, recheck) => {
        validateXTarget(env, "x-fixture", "71");
        return send(env, recheck);
      },
    },
    {
      id: "wa-fixture",
      provider: "whatsapp",
      label: "Workshop business number",
      streams: ["business"],
      pollsNetwork: false,
      check,
      send,
      templates: () => [
        {
          name: "service_update",
          language: "en_US",
          category: "UTILITY",
          body: "Your service update: {{1}}",
        },
      ],
      eligible: (envelope: Envelope) => {
        if (envelope.kind === "template" && envelope.recipient !== "15550100004")
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- the fixture adapter reports the same typed eligibility failure as the live adapter.
          throw new SocialError(409, "consent_required");
      },
    },
  ];
}
