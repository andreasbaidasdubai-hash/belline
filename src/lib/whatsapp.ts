import { getLocation } from "./store";
import { BELLINE_LOCATION_ID } from "./seed-belline";
import { isConfigured } from "./db/client";
import { credentialsConfigured, sealCredentials } from "./db/credentials";
import { migrateReception } from "./reception/migrate";
import { listAccounts, saveAccount } from "./reception/repo";

/**
 * Belline's own WhatsApp number.
 *
 * The channel has been built and tested for a while — the Meta adapter, the
 * webhook, the inbox, the honesty check all handle a WhatsApp thread the way
 * they handle a web chat. What it has been waiting for is a number, and a
 * number on WhatsApp is not a thing code can conjure: Meta verifies the
 * business, issues a phone-number id and a token, and only then does a
 * message go anywhere.
 *
 * So this file does the two things that *can* be done ahead of that:
 *
 *   It knows whether the number exists yet, from the environment, so the
 *   website's "WhatsApp Belle" button can go to WhatsApp when it does and say
 *   so honestly when it does not — without a redeploy in between.
 *
 *   It connects the number to our own venue the moment the credentials
 *   appear, at boot, so the first message that arrives has an account to land
 *   in and a token to answer with. Paste four values into Railway, restart,
 *   and Belle is on WhatsApp.
 *
 * Nothing here touches a customer's WhatsApp. Their numbers are connected by
 * a person, per business, because somebody has to prove they own them.
 */

const REQUIRED = {
  WHATSAPP_NUMBER: "the number, E.164 — the one people message",
  WHATSAPP_PHONE_NUMBER_ID: "Meta's id for that number",
  WHATSAPP_ACCESS_TOKEN: "a permanent system-user token with whatsapp_business_messaging",
  WHATSAPP_APP_SECRET: "the app secret, for webhook signatures",
  WHATSAPP_VERIFY_TOKEN: "the string pasted into Meta's webhook form",
} as const;

/** The E.164 number, or null. Digits and a leading plus, nothing else. */
export function whatsappNumber(): string | null {
  const raw = (process.env.WHATSAPP_NUMBER ?? "").replace(/[^\d+]/g, "");
  return /^\+\d{8,15}$/.test(raw) ? raw : null;
}

/** What is still missing before the number can answer. Empty means ready. */
export function whatsappMissing(): string[] {
  const missing = (Object.keys(REQUIRED) as (keyof typeof REQUIRED)[]).filter(
    (k) => !(process.env[k] ?? "").trim(),
  );
  if (!missing.includes("WHATSAPP_NUMBER") && !whatsappNumber()) missing.push("WHATSAPP_NUMBER");
  return missing;
}

export function whatsappConfigured(): boolean {
  return whatsappMissing().length === 0;
}

/**
 * The link that opens a chat with the number.
 *
 * `wa.me` is Meta's own short link and works on a phone (opens the app) and
 * on a laptop (opens WhatsApp Web) alike. The number goes in without the
 * plus, which is how wa.me wants it.
 */
export function whatsappLink(text?: string): string | null {
  const number = whatsappNumber();
  if (!number) return null;
  const q = text ? `?text=${encodeURIComponent(text)}` : "";
  return `https://wa.me/${number.slice(1)}${q}`;
}

/**
 * Put the number on our own venue, if everything it needs is present.
 *
 * Idempotent: `saveAccount` upserts on (channel, number), and the credential
 * blob is replaced each boot so a rotated token takes effect on restart.
 * Never throws — a boot must not fail because Meta is not ready.
 */
export async function ensureOwnWhatsAppAccount(): Promise<
  { state: "connected"; number: string } | { state: "skipped"; why: string }
> {
  const missing = whatsappMissing();
  if (missing.length) return { state: "skipped", why: `missing ${missing.join(", ")}` };
  if (!isConfigured()) return { state: "skipped", why: "no DATABASE_URL" };
  if (!credentialsConfigured()) return { state: "skipped", why: "no CREDENTIALS_KEY" };

  const venue = getLocation(BELLINE_LOCATION_ID);
  if (!venue) return { state: "skipped", why: "our own venue is not seeded" };

  const number = whatsappNumber()!;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!.trim();

  try {
    await migrateReception();
    // A number already held by another tenant is not ours to take; saveAccount
    // refuses that, and the refusal is the right outcome.
    const claimed = (await listAccounts(venue.tenantId)).find(
      (a) => a.channel === "whatsapp" && a.phoneE164 === number && a.externalNumberId === phoneNumberId,
    );
    await saveAccount({
      tenantId: venue.tenantId,
      businessId: venue.businessId,
      locationId: venue.id,
      channel: "whatsapp",
      provider: "meta",
      phoneE164: number,
      externalNumberId: phoneNumberId,
      credentialsEnc: sealCredentials({
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN!.trim(),
        phoneNumberId,
      }),
      aiEnabled: claimed?.aiEnabled ?? true,
    });
    return { state: "connected", number };
  } catch (err) {
    return { state: "skipped", why: err instanceof Error ? err.message : String(err) };
  }
}
