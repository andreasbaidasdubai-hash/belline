import { getLocation } from "./store";
import type { Location } from "./types";
import type { ChannelAccount } from "./reception/types";
import { BELLINE_LOCATION_ID } from "./seed-belline";
import { isConfigured } from "./db/client";
import { credentialsConfigured, sealCredentials } from "./db/credentials";
import { migrateReception } from "./reception/migrate";
import { listAccounts, saveAccount, setAccountStatus } from "./reception/repo";

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

// ---------------------------------------------------------------------------
// A customer's number — the second-number model
// ---------------------------------------------------------------------------

/**
 * WhatsApp for a customer's venue, without touching the customer's WhatsApp.
 *
 * A number is on the WhatsApp app or on the API, never both, and the number a
 * salon has used for years is not one they will hand over. So a venue gets a
 * *second* number that Belle answers: one we register under Belline's own
 * WhatsApp business account — one business account holds many numbers, and
 * our verification covers all of them — and the venue puts it on its website
 * and its Google profile. Their own WhatsApp stays exactly as it was.
 *
 * Because the number lives in our account, the token is ours (the same one
 * that answers Belle's line) and the webhook is the same: Meta tells us which
 * number a message arrived on, and `accountForInbound` routes it to the venue
 * by that id. What differs per venue is the number, Meta's id for it, and
 * which venue it books into — which is all this function records.
 *
 * Connected by a member of Belline staff from the Clients console, after the
 * number has been added in Meta's dashboard. Not self-serve: adding a number
 * to our account is something only we can do, and the honest thing is a
 * button we press rather than a form a customer fills in and waits on.
 */
export async function connectVenueNumber(input: {
  location: Location;
  number: string;
  phoneNumberId: string;
  aiEnabled?: boolean;
}): Promise<{ ok: true; account: ChannelAccount } | { ok: false; error: string }> {
  const number = input.number.replace(/[^\d+]/g, "");
  if (!/^\+\d{8,15}$/.test(number)) {
    return { ok: false, error: "The number has to be in international form, like +9715XXXXXXXX." };
  }
  const phoneNumberId = input.phoneNumberId.trim();
  if (!/^\d{6,}$/.test(phoneNumberId)) {
    return { ok: false, error: "Meta's phone number ID is a long number, shown under the number in the WhatsApp dashboard." };
  }
  if (!whatsappConfigured()) {
    return {
      ok: false,
      error: `Belline's own WhatsApp account is not connected yet (missing ${whatsappMissing().join(", ")}). A venue's number lives inside it, so ours comes first.`,
    };
  }
  if (!isConfigured()) return { ok: false, error: "No database." };
  if (!credentialsConfigured()) return { ok: false, error: "CREDENTIALS_KEY is not set." };
  if (input.location.demo?.enabled) return { ok: false, error: "That is a demo venue." };

  try {
    await migrateReception();
    const account = await saveAccount({
      tenantId: input.location.tenantId,
      businessId: input.location.businessId,
      locationId: input.location.id,
      channel: "whatsapp",
      provider: "meta",
      phoneE164: number,
      externalNumberId: phoneNumberId,
      credentialsEnc: sealCredentials({
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN!.trim(),
        phoneNumberId,
      }),
      aiEnabled: input.aiEnabled ?? true,
    });
    return { ok: true, account };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The venue's WhatsApp number, if one is connected. Null without a database. */
export async function venueWhatsApp(location: Location): Promise<ChannelAccount | null> {
  if (!isConfigured()) return null;
  await migrateReception();
  return (
    (await listAccounts(location.tenantId)).find(
      (a) => a.channel === "whatsapp" && a.locationId === location.id && a.status === "active",
    ) ?? null
  );
}

/** Stop answering on a venue's number. The row stays, for the history it holds. */
export async function disconnectVenueNumber(location: Location): Promise<boolean> {
  const account = await venueWhatsApp(location);
  if (!account) return false;
  await setAccountStatus(location.tenantId, account.id, "paused");
  return true;
}
