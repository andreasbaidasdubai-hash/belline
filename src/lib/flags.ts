import { isLocalDbUrl } from "./db/guard";

/**
 * Feature flags: what Belline can honestly offer on this deployment.
 *
 * Until now every page worked out for itself whether WhatsApp or Stripe was
 * usable, from whichever env var it happened to look at, so the website and
 * the app disagreed. This is the one answer the UI, the site build, the
 * agent's tool list and `check:honesty` all read.
 *
 * A flag is on only when its credentials are present and nobody has set
 * `FLAG_<NAME>=off`. Some capabilities also wait on an approval no env var can
 * show — Google's app verification, a lawyer's opinion, Meta's review — and
 * those need an explicit `FLAG_<NAME>=on` as well. With no env at all, every
 * flag is off.
 *
 * `stubs` is the exception. It is for local end-to-end runs only: it swaps
 * every provider for a fake, stands in for the missing credentials, and
 * refuses to turn on in production or next to a real database.
 */

export const FLAG_NAMES = [
  "numbers.pool",
  "channel.phone",
  "channel.whatsapp.selfserve",
  "channel.whatsapp.embedded",
  "billing.stripe",
  "email.transactional",
  "lifecycle.send",
  "import.model",
  "import.maps",
  "booking.google",
  "booking.outlook",
  "vertical.clinic.selfserve",
  "forwarding.autotest",
  "forwarding.carrier.virgin",
  "stubs",
] as const;

export type StaticFlag = (typeof FLAG_NAMES)[number];
export type FlagName = StaticFlag | `booking.partner.${string}`;

type Env = Record<string, string | undefined>;

interface FlagDef {
  /** Every one of these env vars must be set. */
  needs: readonly string[];
  /** Waits on an approval env cannot show, so `FLAG_<NAME>=on` is required too. */
  explicit: boolean;
}

const TWILIO = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"];
const META = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_BUSINESS_ACCOUNT_ID", "CREDENTIALS_KEY"];

const DEFS: Record<Exclude<StaticFlag, "stubs">, FlagDef> = {
  // Numbers are bought by a person; nothing in env says the pool has any.
  "numbers.pool": { needs: TWILIO, explicit: true },
  "channel.phone": { needs: [...TWILIO, "ANTHROPIC_API_KEY", "DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY"], explicit: false },
  // Meta business verification and the token rotation come first.
  "channel.whatsapp.selfserve": { needs: META, explicit: true },
  "channel.whatsapp.embedded": { needs: META, explicit: true },
  "billing.stripe": { needs: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], explicit: false },
  "email.transactional": { needs: ["RESEND_API_KEY"], explicit: false },
  // Marketing-style mail to owners stays off until someone decides to send it.
  "lifecycle.send": { needs: ["RESEND_API_KEY"], explicit: true },
  "import.model": { needs: ["ANTHROPIC_API_KEY"], explicit: false },
  "import.maps": { needs: ["GOOGLE_PLACES_API_KEY"], explicit: false },
  // Google's OAuth verification; the site keeps "Coming soon" until this is on.
  "booking.google": { needs: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "CREDENTIALS_KEY"], explicit: true },
  "booking.outlook": { needs: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "CREDENTIALS_KEY"], explicit: true },
  // Waits on the health-data opinion.
  "vertical.clinic.selfserve": { needs: [], explicit: true },
  "forwarding.autotest": { needs: [...TWILIO, "TWILIO_TESTER_NUMBER"], explicit: true },
  // Codes verified by a real test call on the carrier first.
  "forwarding.carrier.virgin": { needs: [], explicit: true },
};

function partnerId(name: string): string | null {
  const m = /^booking\.partner\.([a-z0-9-]+)$/.exec(name);
  return m ? m[1] : null;
}

function defFor(name: FlagName): FlagDef | null {
  const partner = partnerId(name);
  if (partner) {
    // Partner credentials are issued under contract, one set per partner.
    return { needs: [`PARTNER_${partner.toUpperCase().replace(/-/g, "_")}_API_KEY`], explicit: true };
  }
  return (DEFS as Record<string, FlagDef>)[name] ?? null;
}

/** `channel.whatsapp.selfserve` → `FLAG_CHANNEL_WHATSAPP_SELFSERVE`. */
export function flagEnvKey(name: FlagName): string {
  return `FLAG_${name.toUpperCase().replace(/[.-]/g, "_")}`;
}

function setting(env: Env, name: FlagName): "on" | "off" | undefined {
  const raw = (env[flagEnvKey(name)] ?? "").trim().toLowerCase();
  return raw === "on" ? "on" : raw === "off" ? "off" : undefined;
}

export type FlagReason =
  | "on"
  | "disabled"
  | "missing_credentials"
  | "needs_approval"
  | "unsafe"
  | "unknown";

export interface FlagState {
  name: FlagName;
  on: boolean;
  reason: FlagReason;
  /** Env vars still missing. Names only, never values. */
  missing: string[];
}

/** Why `FLAG_STUBS=on` must not take effect here, or null when it is safe. */
export function stubsRefusal(env: Env = process.env): string | null {
  if (env.NODE_ENV === "production") {
    return "FLAG_STUBS=on is refused: NODE_ENV is production. Stub providers are for local test runs only.";
  }
  const url = env.DATABASE_URL ?? "";
  if (url && !isLocalDbUrl(url)) {
    return "FLAG_STUBS=on is refused: DATABASE_URL is not localhost or disabled.invalid. Stub providers never run next to a real database.";
  }
  return null;
}

export function stubsRequested(env: Env = process.env): boolean {
  return setting(env, "stubs") === "on";
}

/** Throws when stubs were asked for somewhere they must not run. */
export function assertStubsSafe(env: Env = process.env): void {
  if (!stubsRequested(env)) return;
  const refusal = stubsRefusal(env);
  if (refusal) throw new Error(refusal);
}

export function flagState(name: FlagName, env: Env = process.env): FlagState {
  const set = setting(env, name);

  if (name === "stubs") {
    if (set !== "on") return { name, on: false, reason: "disabled", missing: [] };
    return stubsRefusal(env)
      ? { name, on: false, reason: "unsafe", missing: [] }
      : { name, on: true, reason: "on", missing: [] };
  }

  const def = defFor(name);
  if (!def) return { name, on: false, reason: "unknown", missing: [] };
  if (set === "off") return { name, on: false, reason: "disabled", missing: [] };

  // Under stubs the fakes stand in for credentials, but the capability still
  // has to be asked for by name: a stubbed run turns on what it tests.
  const stubbed = flagState("stubs", env).on;
  if (stubbed) {
    return set === "on"
      ? { name, on: true, reason: "on", missing: [] }
      : { name, on: false, reason: "disabled", missing: [] };
  }

  const missing = def.needs.filter((k) => !(env[k] ?? "").trim());
  if (missing.length) return { name, on: false, reason: "missing_credentials", missing };
  if (def.explicit && set !== "on") return { name, on: false, reason: "needs_approval", missing: [] };
  return { name, on: true, reason: "on", missing: [] };
}

export function flag(name: FlagName, env: Env = process.env): boolean {
  return flagState(name, env).on;
}

/** Every static flag, for the ops page and the site build. */
export function allFlags(env: Env = process.env): FlagState[] {
  return FLAG_NAMES.map((name) => flagState(name, env));
}
