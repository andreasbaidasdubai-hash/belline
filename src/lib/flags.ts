/**
 * Feature flags.
 *
 * One source for "is this actually available", read by the app, by outreach
 * and by the checks. The shape follows the zero-touch plan §2.2 so that this
 * and the branch building the rest of it merge cleanly.
 *
 * A flag is on only when it is **not explicitly disabled** and its
 * prerequisites are met. Two kinds of prerequisite:
 *
 *   · credentials that can be detected — the flag turns itself on when they
 *     are present, because a key in the environment is evidence the thing
 *     works;
 *   · an approval that cannot be detected — Google's OAuth verification, a
 *     signed partner agreement, a lawyer's opinion. Nothing in the
 *     environment proves those, so they need `FLAG_<NAME>=on` said out loud.
 *
 * Everything defaults to off. A flag that is off must make its claim fail,
 * not merely hide a button: the outreach guards read this, and the whole
 * point is that an agent cannot sell what we cannot do.
 */

export type Flag =
  | "booking.google"
  | "booking.outlook"
  | "booking.partner"
  | "channel.whatsapp.selfserve"
  | "billing.stripe"
  | "email.transactional"
  | "lifecycle.send";

/** FLAG_BOOKING_GOOGLE, and so on. */
export function envKey(flag: Flag): string {
  return `FLAG_${flag.toUpperCase().replace(/[.-]/g, "_")}`;
}

/**
 * Flags no environment variable can justify on its own.
 *
 * Google will happily issue client credentials for scopes it has not verified
 * you for, so the presence of a client id proves nothing about whether we are
 * allowed to use `calendar.events` in production. Same for a partner: the
 * adapter compiling is not a signed agreement.
 */
const NEEDS_SAYING_OUT_LOUD = new Set<Flag>([
  "booking.google",
  "booking.outlook",
  "booking.partner",
  "lifecycle.send",
]);

/** Credentials that, when all present, are enough on their own. */
const CREDENTIALS: Partial<Record<Flag, string[]>> = {
  "channel.whatsapp.selfserve": ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_BUSINESS_ACCOUNT_ID"],
  "billing.stripe": ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  "email.transactional": ["RESEND_API_KEY", "EMAIL_FROM"],
};

const OFF = new Set(["off", "false", "0", "no"]);
const ON = new Set(["on", "true", "1", "yes"]);

export function flagEnabled(
  flag: Flag,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const setting = (env[envKey(flag)] ?? "").trim().toLowerCase();

  // An explicit off always wins, including over present credentials. It is
  // how a thing gets switched off in a hurry without revoking a key.
  if (OFF.has(setting)) return false;

  if (NEEDS_SAYING_OUT_LOUD.has(flag)) return ON.has(setting);

  const needs = CREDENTIALS[flag] ?? [];
  if (needs.length === 0) return ON.has(setting);
  return needs.every((key) => (env[key] ?? "").trim().length > 0);
}

/** Every flag currently on. Handy for a check, and for a debug panel. */
export function enabledFlags(
  env: Record<string, string | undefined> = process.env,
): Flag[] {
  const all: Flag[] = [
    "booking.google",
    "booking.outlook",
    "booking.partner",
    "channel.whatsapp.selfserve",
    "billing.stripe",
    "email.transactional",
    "lifecycle.send",
  ];
  return all.filter((f) => flagEnabled(f, env));
}
