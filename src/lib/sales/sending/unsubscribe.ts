/**
 * Unsubscribe: the link, the headers, and the wording.
 *
 * Three things have to be true of every message this engine sends, and all
 * three are produced here so that none of them can be produced anywhere else:
 *
 *  - a one-click link that works without the recipient logging in, replying,
 *    or explaining themselves;
 *  - `List-Unsubscribe` and `List-Unsubscribe-Post`, so Gmail and Outlook
 *    offer their own unsubscribe button — which is both a deliverability
 *    signal and, more importantly, the route most people actually take;
 *  - a footer in the recipient's language naming who is writing to them.
 *
 * The token is an HMAC over the send item and the company. It carries the
 * company id deliberately: an unsubscribe from one address suppresses the
 * whole company, everywhere, for good. Somebody at a practice who says stop is
 * saying it for the practice, and treating `info@` and `manager@` as separate
 * opinions is how a business gets written to after asking you not to.
 */

import crypto from "node:crypto";

export type Env = Record<string, string | undefined>;

export interface UnsubscribeClaim {
  itemId: number;
  companyId: number | null;
  email: string;
}

const PREFIX = "blu1";

function secretOf(env: Env): string {
  const secret = env.OUTREACH_UNSUBSCRIBE_SECRET?.trim() || env.VIDEO_DEMO_SECRET?.trim() || env.SESSION_SECRET?.trim();
  if (!secret) {
    // Not a soft failure. A message whose unsubscribe link cannot be verified
    // is a message with no opt-out, and the engine refuses to build one.
    throw new Error(
      "OUTREACH_UNSUBSCRIBE_SECRET is not set, so no unsubscribe link can be signed and nothing may be sent.",
    );
  }
  return secret;
}

export function unsubscribeSecretPresent(env: Env = process.env): boolean {
  try {
    secretOf(env);
    return true;
  } catch {
    return false;
  }
}

function mac(payload: string, env: Env): string {
  return crypto
    .createHmac("sha256", secretOf(env))
    .update(`${PREFIX}.${payload}`)
    .digest("base64url")
    .slice(0, 32);
}

/** `blu1.<itemId>.<companyId|->.<emailHash>.<mac>` — opaque, but decodable by us. */
export function signUnsubscribeToken(claim: UnsubscribeClaim, env: Env = process.env): string {
  const emailHash = crypto.createHash("sha256").update(claim.email.trim().toLowerCase()).digest("base64url").slice(0, 16);
  const payload = `${claim.itemId}.${claim.companyId ?? "-"}.${emailHash}`;
  return `${PREFIX}.${payload}.${mac(payload, env)}`;
}

export interface VerifiedToken {
  itemId: number;
  companyId: number | null;
  emailHash: string;
}

export function verifyUnsubscribeToken(token: unknown, env: Env = process.env): VerifiedToken | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== PREFIX) return null;
  const [, itemId, companyId, emailHash, given] = parts;
  const payload = `${itemId}.${companyId}.${emailHash}`;
  let expected: string;
  try {
    expected = mac(payload, env);
  } catch {
    return null;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return { itemId: id, companyId: companyId === "-" ? null : Number(companyId), emailHash };
}

export function unsubscribeUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/u/${token}`;
}

/**
 * The headers. Both, always.
 *
 * `List-Unsubscribe-Post` is what turns the mailto/URL pair into a one-click
 * button rather than a link the provider hides. Without it Gmail treats the
 * header as advisory and shows nothing.
 */
export function unsubscribeHeaders(input: { url: string; mailto?: string }): Record<string, string> {
  const targets = [input.mailto ? `<mailto:${input.mailto}?subject=unsubscribe>` : null, `<${input.url}>`]
    .filter(Boolean)
    .join(", ");
  return {
    "List-Unsubscribe": targets,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

export interface FooterInput {
  language: string;
  url: string;
  /**
   * The privacy notice written for people we contacted uninvited
   * (`src/lib/legal/outreach-privacy.ts`).
   *
   * Beside the unsubscribe link, never instead of it. They answer different
   * questions and only one of them was here before: the link stops the next
   * message, the notice is the Art. 13/14 information about the processing
   * that has already happened — who we are, what we hold about this person,
   * where we got it, and their Art. 21 right to object. An opt-out alone is
   * not that information, and this footer used to offer only the opt-out.
   */
  privacyUrl: string;
  entity: string;
  address: string;
  managingDirector?: string;
  registration?: string;
  vatNumber?: string;
  email?: string;
}

/**
 * The footer, in the recipient's language.
 *
 * The German version is not a translation of the English one. German
 * commercial email is expected to carry an Impressum-shaped block — the
 * entity, its legal form, its address, who represents it and its register
 * entry — and an English "Belline · Dubai" line under a German email is worse
 * than useless: it reads as a foreign sender who has not bothered, which is
 * exactly the impression that turns an annoyed recipient into a complaint.
 *
 * The privacy notice is named in the same way and for the same reason, and
 * the URL itself differs by language: a German reader is sent to the German
 * notice, not to an English page about their own data.
 */
export function footerFor(input: FooterInput): string {
  const lines: string[] = ["—"];
  const german = input.language.toLowerCase().startsWith("de");

  if (german) {
    lines.push(input.entity || "Belline");
    if (input.address) lines.push(input.address);
    if (input.managingDirector) lines.push(`Vertretungsberechtigt: ${input.managingDirector}`);
    if (input.registration) lines.push(`Registereintrag: ${input.registration}`);
    if (input.vatNumber) lines.push(`USt-IdNr.: ${input.vatNumber}`);
    if (input.email) lines.push(`E-Mail: ${input.email}`);
    lines.push("");
    lines.push(
      "Sie erhalten diese E-Mail einmalig als geschäftliche Ansprache. Wenn Sie keine weiteren " +
        "Nachrichten wünschen, genügt ein Klick — Sie werden dauerhaft gelöscht:",
    );
    lines.push(input.url);
    lines.push("");
    lines.push(privacySentence("de", input.privacyUrl));
    return lines.join("\n");
  }

  lines.push([input.entity, input.address].filter(Boolean).join(" · ") || "Belline");
  if (input.email) lines.push(input.email);
  lines.push("");
  lines.push(`Not for you? Unsubscribe — one click, and I will not write again: ${input.url}`);
  lines.push("");
  lines.push(privacySentence("en", input.privacyUrl));
  return lines.join("\n");
}

/**
 * The line that points at the privacy notice, in the recipient's language.
 *
 * It says where the address came from, because that is the first thing
 * somebody wants to know when a stranger emails them at work, and because
 * Art. 14(2)(f) requires it to be said. The rest is on the page.
 */
export function privacySentence(language: string, url: string): string {
  return language.toLowerCase().startsWith("de")
    ? "Ihre Kontaktdaten stammen aus einem öffentlichen Unternehmensverzeichnis bzw. Ihrer Website. " +
        `Wie wir sie verarbeiten und wie Sie nach Art. 21 DSGVO widersprechen: ${url}`
    : "We found your address in a public business listing or on your website. " +
        `What we hold, why, and how to object: ${url}`;
}

/**
 * The single sentence that replaces the frame's own unsubscribe line.
 *
 * The outreach templates carry a "reply STOP" sentence for the era before
 * there was a sender. Now that there is one, a real link replaces it, and this
 * is the wording per language.
 */
export function unsubscribeSentence(language: string, url: string): string {
  return language.toLowerCase().startsWith("de")
    ? `Keine weiteren Nachrichten? Ein Klick genügt: ${url}`
    : `Not for you? One click and I won't write again: ${url}`;
}
