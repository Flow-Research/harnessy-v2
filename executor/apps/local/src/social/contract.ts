import type { FixtureBookmark } from "./bookmarks";

export type Stream = "mention" | "feed" | "dm" | "business";
export type Visibility = "public" | "private" | "protected" | "unknown";
export interface Attachment {
  id: string;
  type: string;
  size?: number;
}
export interface InboundItem {
  type: "item";
  providerId: string;
  threadId: string;
  senderId: string;
  sender: string;
  text: string;
  stream: Stream;
  at: number;
  direction?: "in" | "out";
  visibility?: Visibility;
  attachments?: Attachment[];
  optOut?: boolean;
}
export type SocialEvent =
  | InboundItem
  | {
      type: "status";
      providerId: string;
      status: "accepted" | "delivered" | "read" | "failed";
      attemptRef?: string;
      at: number;
    };
export interface Template {
  name: string;
  language: string;
  body: string;
  category: string;
}
export interface Envelope {
  /** Opaque correlation for the verified provider callback. Added only after approval. */
  attemptRef?: string;
  accountId: string;
  recipient: string;
  targetId: string | null;
  kind: "post" | "reply" | "dm" | "business" | "template";
  text: string;
  template?: { name: string; language: string; parameters: string[] };
}
export interface SocialAdapter {
  id: string;
  provider: "x" | "whatsapp";
  label: string;
  streams: readonly Stream[];
  /** False for fixture data and local webhook-backed checks. Polling adapters use a durable read budget. */
  pollsNetwork?: boolean;
  fixtureBookmarks?: readonly FixtureBookmark[];
  check(
    stream: Stream,
    cursor: string | null,
  ): Promise<{ events: SocialEvent[]; cursor: string | null }>;
  send(envelope: Envelope, recheck?: () => void): Promise<{ providerId: string }>;
  templates?(): readonly Template[];
  eligible?(envelope: Envelope): void;
}
export interface SocialPrincipal {
  id: string;
  workspaceId: string;
  kind: "agent" | "human";
  accountIds: readonly string[];
  canApprove?: boolean;
}
export class SocialError extends Error {
  static recognized(value: unknown): value is SocialError {
    return typeof value === "object" && value !== null && #status in value;
  }
  readonly #status: number;
  get status() {
    return this.#status;
  }
  readonly code: string;
  readonly retryAt: number | undefined;
  constructor(status: number, code: string, retryAt?: number) {
    super(code);
    this.#status = status;
    this.code = code;
    this.retryAt = retryAt;
  }
}

export function isSocialError(value: unknown): value is SocialError {
  return SocialError.recognized(value);
}
