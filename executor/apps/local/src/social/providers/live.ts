import type { SocialAdapter } from "../contract";
import { WhatsAppProvider } from "./whatsapp";
import { XProvider } from "./x";
import { fail } from "./transport";

/** Called only for explicit live mode. Secrets remain on the host. */
export function createLiveProviders(env: NodeJS.ProcessEnv = process.env) {
  const reads = env.HARNESSY_SOCIAL_LIVE_READS === "true";
  const writes = env.HARNESSY_SOCIAL_LIVE_WRITES === "true";
  const required = (name: string): string =>
    env[name]?.trim() || fail(400, "missing_" + name.toLowerCase());
  const numbers = (name: string) => {
    const values = (env[name] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (values.some((v) => !/^[1-9]\d{5,14}$/.test(v)))
      return fail(400, "invalid_" + name.toLowerCase());
    return new Set(values);
  };
  const x = env.X_CLIENT_ID
    ? new XProvider({
        clientId: required("X_CLIENT_ID"),
        clientSecret: env.X_CLIENT_SECRET,
        userId: required("X_USER_ID"),
        redirectUri: required("X_REDIRECT_URI"),
        offline: env.X_OFFLINE_ACCESS === "true",
        reads,
        writes,
      })
    : undefined;
  const whatsapp = env.WA_PHONE_NUMBER_ID
    ? new WhatsAppProvider({
        wabaId: required("WA_BUSINESS_ACCOUNT_ID"),
        phoneId: required("WA_PHONE_NUMBER_ID"),
        token: required("WA_ACCESS_TOKEN"),
        appSecret: required("META_APP_SECRET"),
        verifyToken: required("META_WEBHOOK_VERIFY_TOKEN"),
        graphVersion: env.WA_GRAPH_VERSION ?? "v27.0",
        reads,
        writes,
        templateConsent: numbers("WA_TEMPLATE_CONSENT_RECIPIENTS"),
        optOut: numbers("WA_OPT_OUT_RECIPIENTS"),
        template: env.WA_TEMPLATE_NAME
          ? {
              name: required("WA_TEMPLATE_NAME"),
              language: required("WA_TEMPLATE_LANGUAGE"),
              body: required("WA_TEMPLATE_BODY"),
              category: "UTILITY",
            }
          : undefined,
      })
    : undefined;
  const adapters: SocialAdapter[] = [];
  if (x) adapters.push(x);
  if (whatsapp) adapters.push(whatsapp);
  if (!adapters.length) fail(400, "no_live_accounts");
  return { adapters, x, whatsapp };
}
