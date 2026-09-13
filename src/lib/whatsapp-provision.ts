/**
 * Putting a venue's number on WhatsApp, self-serve.
 *
 * The whole onboarding is two steps a minute apart: the owner types the
 * number they bought, Meta texts that SIM a six-digit code, the owner types
 * the code. Behind it are four Graph API calls against Belline's own
 * WhatsApp business account — add the number, ask for the code, verify it,
 * register the number for the Cloud API — and every one of them is here,
 * with Meta's errors translated into a sentence a salon owner can act on.
 *
 * The Graph client is injected so the flow can be tested end to end without
 * a Meta account, and so the routes never build a URL themselves.
 */

export interface GraphReply {
  ok: boolean;
  status: number;
  body: { id?: string; success?: boolean; error?: { message?: string; code?: number; error_subcode?: number } } & Record<string, unknown>;
}

export interface Graph {
  post(path: string, body: Record<string, unknown>): Promise<GraphReply>;
}

const VERSION = process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0";

/** The real thing. Bearer token from the environment; JSON in, JSON out. */
export function graphClient(token = process.env.WHATSAPP_ACCESS_TOKEN ?? ""): Graph {
  return {
    async post(path, body) {
      const res = await fetch(`https://graph.facebook.com/${VERSION}/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const json = (await res.json().catch(() => ({}))) as GraphReply["body"];
      return { ok: res.ok, status: res.status, body: json };
    },
  };
}

/** What self-serve provisioning needs on top of a connected line. */
export function provisioningMissing(): string[] {
  return ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_BUSINESS_ACCOUNT_ID"].filter(
    (k) => !(process.env[k] ?? "").trim(),
  );
}

export function provisioningReady(): boolean {
  return provisioningMissing().length === 0;
}

/**
 * The number split the way Meta wants it: country code and the rest, no plus.
 * Only the UAE and the handful of codes a Belline customer plausibly has;
 * anything else is refused with the reason rather than guessed at.
 */
const COUNTRY_CODES = ["971", "966", "974", "968", "973", "965", "44", "41", "49", "33", "1"];

export function splitNumber(raw: string): { cc: string; national: string; e164: string } | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!/^\+\d{8,15}$/.test(digits)) return null;
  const bare = digits.slice(1);
  const cc = COUNTRY_CODES.find((c) => bare.startsWith(c));
  if (!cc) return null;
  const national = bare.slice(cc.length);
  if (national.length < 6) return null;
  return { cc, national, e164: digits };
}

/**
 * Meta's error, in words.
 *
 * The codes are the ones that come up when a number is added by hand; the
 * fallback quotes Meta so a surprise is at least visible. None of these
 * should ever say "error code".
 */
export function explain(reply: GraphReply): string {
  const err = reply.body.error;
  const code = err?.code;
  const msg = (err?.message ?? "").toLowerCase();

  if (code === 190 || reply.status === 401) return "Belline's WhatsApp token has expired — this is ours to fix, not yours. Email hello@belline.ai.";
  if (msg.includes("already") && (msg.includes("registered") || msg.includes("in use") || msg.includes("exists"))) {
    return "That number is already on WhatsApp — on a phone, or in another business account. Use a number that has never been on WhatsApp, or delete WhatsApp on that SIM first.";
  }
  if (msg.includes("invalid") && msg.includes("code")) return "That code isn't right. Check the SMS and try again.";
  if (msg.includes("expired") && msg.includes("code")) return "That code has expired. Ask for a new one.";
  if (msg.includes("too many") || code === 4 || code === 613) return "Meta is asking us to slow down. Wait a few minutes and try again.";
  if (msg.includes("display name") || msg.includes("verified_name")) return "Meta didn't accept that name for the number. Use your business's name as it appears on your signage.";
  if (msg.includes("phone number") && msg.includes("valid")) return "Meta doesn't recognise that as a mobile number. Check the digits.";
  return err?.message ? `Meta said: ${err.message}` : "WhatsApp didn't answer. Try again in a moment.";
}

export interface StartInput {
  wabaId: string;
  number: string;
  displayName: string;
  graph: Graph;
  /** SMS unless the SIM cannot receive one — then Meta rings it and reads the code. */
  method?: "SMS" | "VOICE";
}

/**
 * Step one: add the number to our account and have Meta send the code.
 *
 * Returns Meta's id for the number, which is what every later call — and the
 * routing of every inbound message — is keyed on.
 */
export async function startNumber(input: StartInput): Promise<{ ok: true; phoneNumberId: string } | { ok: false; error: string }> {
  const parts = splitNumber(input.number);
  if (!parts) return { ok: false, error: "The number has to be a mobile number in international form, like +9715XXXXXXXX." };
  const name = input.displayName.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 40) return { ok: false, error: "The name shown on WhatsApp has to be 2 to 40 characters." };

  const added = await input.graph.post(`${input.wabaId}/phone_numbers`, {
    cc: parts.cc,
    phone_number: parts.national,
    verified_name: name,
  });
  if (!added.ok || !added.body.id) return { ok: false, error: explain(added) };
  const phoneNumberId = String(added.body.id);

  const sent = await input.graph.post(`${phoneNumberId}/request_code`, {
    code_method: input.method ?? "SMS",
    language: "en_US",
  });
  if (!sent.ok) return { ok: false, error: explain(sent) };

  return { ok: true, phoneNumberId };
}

/** Ask for the code again, on the same number. */
export async function resendCode(phoneNumberId: string, graph: Graph, method: "SMS" | "VOICE" = "SMS"): Promise<{ ok: true } | { ok: false; error: string }> {
  const sent = await graph.post(`${phoneNumberId}/request_code`, { code_method: method, language: "en_US" });
  return sent.ok ? { ok: true } : { ok: false, error: explain(sent) };
}

/**
 * Step two: the code the owner read off the SMS, then registration.
 *
 * Registration needs a six-digit PIN — Meta's two-step verification for the
 * number. Generated here, returned to the caller to be sealed with the
 * number's credentials, and never shown to anybody: it is only needed if the
 * number ever has to be registered again.
 */
export async function finishNumber(input: {
  phoneNumberId: string;
  code: string;
  graph: Graph;
}): Promise<{ ok: true; pin: string } | { ok: false; error: string }> {
  const code = input.code.replace(/\D/g, "");
  if (code.length < 4 || code.length > 8) return { ok: false, error: "The code is the six digits in the SMS." };

  const verified = await input.graph.post(`${input.phoneNumberId}/verify_code`, { code });
  if (!verified.ok) return { ok: false, error: explain(verified) };

  const pin = String(Math.floor(100000 + Math.random() * 900000));
  const registered = await input.graph.post(`${input.phoneNumberId}/register`, {
    messaging_product: "whatsapp",
    pin,
  });
  if (!registered.ok) return { ok: false, error: explain(registered) };

  return { ok: true, pin };
}
