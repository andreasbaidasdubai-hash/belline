/**
 * How a reply finds its way back to the send it answers.
 *
 * Inbound mail has no foreign keys. A person hits reply in Outlook and what
 * arrives is a message with an address, some quoted text, and — if we planned
 * for it — one or two identifiers we put there ourselves. Everything in this
 * file is the planning for it, minted on the way out so that the way in is a
 * lookup rather than a guess.
 *
 * Three identifiers, deliberately, because each of them is lost in a different
 * situation:
 *
 *  1. **Message-ID.** Quoted back in `In-Reply-To` and `References` by every
 *     mail client that threads, which is nearly all of them. The best signal
 *     there is: it names the exact message, not the person.
 *
 *  2. **A plus-address on Reply-To.** `andreas+b12.9f3a@try-belline.com`.
 *     Survives clients that strip threading headers, forwards, and a reply
 *     composed fresh. Lost when someone types the address by hand or replies
 *     to a colleague's forward.
 *
 *  3. **The address itself.** Last, and only ever narrowed to a lead, never to
 *     a particular send — two people at one practice share a domain and a
 *     shared mailbox may answer for either of them.
 *
 * Both minted identifiers carry a short HMAC. Not to keep them secret — they
 * travel in the clear in every message — but so that a forged `In-Reply-To`
 * cannot make us attribute a stranger's mail to a lead, and through that stop a
 * sequence or suppress a company that never wrote to us.
 */

import crypto from "node:crypto";

export type Env = Record<string, string | undefined>;

const PREFIX = "blt1";
const MAC_LENGTH = 12;

/**
 * The signing secret, shared with the unsubscribe link.
 *
 * The same chain as `unsubscribe.ts` on purpose: one secret to set, and a
 * deployment that can sign an opt-out can also thread a reply. Throwing rather
 * than returning null is deliberate in the same way — a message whose reply we
 * could not attribute is a follow-up to somebody who already answered.
 */
export function threadSecret(env: Env = process.env): string {
  const secret =
    env.OUTREACH_UNSUBSCRIBE_SECRET?.trim() || env.VIDEO_DEMO_SECRET?.trim() || env.SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "OUTREACH_UNSUBSCRIBE_SECRET is not set, so no reply can be attributed to the message it answers.",
    );
  }
  return secret;
}

export function threadSecretPresent(env: Env = process.env): boolean {
  try {
    threadSecret(env);
    return true;
  } catch {
    return false;
  }
}

function mac(payload: string, env: Env): string {
  return crypto
    .createHmac("sha256", threadSecret(env))
    .update(`${PREFIX}.${payload}`)
    .digest("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, MAC_LENGTH);
}

function macMatches(payload: string, given: string, env: Env): boolean {
  let expected: string;
  try {
    expected = mac(payload, env);
  } catch {
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// The token both identifiers are built from
// ---------------------------------------------------------------------------

/**
 * `b<itemId>.<mac>` — short enough for a plus-address, and self-describing.
 *
 * Lower-case and alphanumeric-plus-one-dot, because it has to survive being
 * part of an email address: some receiving systems lower-case the local part,
 * and anything else risks being mangled or rejected on the way.
 */
export function mintReplyToken(itemId: number, env: Env = process.env): string {
  const payload = `b${itemId}`;
  return `${payload}.${mac(payload, env)}`;
}

/** The item id a token names, or null if it was not minted by us. */
export function verifyReplyToken(token: unknown, env: Env = process.env): number | null {
  if (typeof token !== "string") return null;
  const match = /^b(\d{1,15})\.([a-z0-9]{1,32})$/.exec(token.trim().toLowerCase());
  if (!match) return null;
  if (!macMatches(`b${match[1]}`, match[2], env)) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// ---------------------------------------------------------------------------
// Message-ID
// ---------------------------------------------------------------------------

/**
 * The `Message-ID` for one send, without the angle brackets.
 *
 * `blt1.b12.9f3a....<random>@try-belline.com`. The random part is what stops
 * two sends to the same item — a retry after a crash, say — from colliding on
 * an identifier the recipient's client will treat as one conversation.
 */
export function mintMessageId(itemId: number, domain: string, env: Env = process.env): string {
  const token = mintReplyToken(itemId, env);
  const nonce = crypto.randomBytes(8).toString("hex");
  return `${PREFIX}.${token}.${nonce}@${domain}`;
}

/**
 * The item id inside a Message-ID we minted, or null.
 *
 * Tolerant of the angle brackets, of leading and trailing whitespace, and of a
 * client that has lower-cased the whole thing. Intolerant of a bad signature:
 * an `In-Reply-To` is attacker-controllable, and an unverified one would let
 * anybody stop any sequence by quoting a guessed id.
 */
export function parseMessageId(value: unknown, env: Env = process.env): number | null {
  if (typeof value !== "string") return null;
  const bare = value.trim().replace(/^<|>$/g, "").trim();
  const at = bare.lastIndexOf("@");
  const local = (at === -1 ? bare : bare.slice(0, at)).toLowerCase();
  const parts = local.split(".");
  if (parts.length < 3 || parts[0] !== PREFIX) return null;
  return verifyReplyToken(`${parts[1]}.${parts[2]}`, env);
}

/** Every Message-ID in a `References` or `In-Reply-To` header, in order. */
export function messageIdsIn(header: string | null | undefined): string[] {
  if (!header) return [];
  const out = header.match(/<[^<>\s]+>/g) ?? [];
  // A header with no brackets at all still usually holds one bare id.
  if (out.length === 0 && header.trim() && !/\s/.test(header.trim())) return [header.trim()];
  return out.map((v) => v.replace(/^<|>$/g, ""));
}

// ---------------------------------------------------------------------------
// The plus-address
// ---------------------------------------------------------------------------

/** `andreas@try-belline.com` + a token → `andreas+b12.9f3a@try-belline.com`. */
export function plusAddress(mailbox: string, token: string): string {
  const at = mailbox.lastIndexOf("@");
  if (at === -1) return mailbox;
  const local = mailbox.slice(0, at).split("+")[0];
  return `${local}+${token}@${mailbox.slice(at + 1)}`;
}

/** The token out of a plus-address, or null when there is not one. */
export function tokenInAddress(address: unknown): string | null {
  if (typeof address !== "string") return null;
  const at = address.lastIndexOf("@");
  if (at === -1) return null;
  const local = address.slice(0, at);
  const plus = local.indexOf("+");
  if (plus === -1) return null;
  const token = local.slice(plus + 1).trim().toLowerCase();
  return token || null;
}

/**
 * Every address in a header that may hold several, bare of display names.
 *
 * `"Dr Khan" <info@clinic.test>, andreas+b1.x@try-belline.com` → both, lower
 * case. Good enough for `To`, `Cc` and SES's own recipient list, which is what
 * this is used on; it is not a general RFC 5322 address parser and does not
 * pretend to be.
 */
export function addressesIn(header: string | null | undefined): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const piece of header.split(",")) {
    const angled = /<([^<>]+)>/.exec(piece);
    const candidate = (angled ? angled[1] : piece).trim().replace(/^"|"$/g, "").trim();
    if (candidate.includes("@")) out.push(candidate.toLowerCase());
  }
  return out;
}

/** The first address in a header, or null. */
export function firstAddress(header: string | null | undefined): string | null {
  return addressesIn(header)[0] ?? null;
}

/** The domain half of an address, lower case. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).trim().toLowerCase();
}

/** An address with any plus-suffix removed, for comparing to a mailbox row. */
export function baseAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at === -1) return address.trim().toLowerCase();
  return `${address.slice(0, at).split("+")[0]}@${address.slice(at + 1)}`.trim().toLowerCase();
}
