import { promises as dns } from "node:dns";

/**
 * Is this address real, and did they mean to type it?
 *
 * A booking form's whole job is to produce a reply that arrives. A regex only
 * proves the string has an @ in it, and the two ways a lead actually dies are
 * a fat-fingered domain — `gmial.com`, `hotmial.com` — and a domain that
 * cannot receive mail at all. So this checks four separate things and keeps
 * them separate, because they call for different answers:
 *
 *   Shape. Wrong shape is a hard refusal; nothing else can be true.
 *   Spelling. A near-miss on a known domain is a *suggestion*, never a
 *     refusal — somebody's real address may genuinely be at `gmai.ae`, and
 *     refusing it would be the form telling a customer they do not exist.
 *   Deliverability. No MX record means mail bounces. Checked over DNS.
 *   Throwaway. A ten-minute mailbox is not a lead; it is someone browsing.
 *
 * The suggestion path matters more than it looks: a mistyped domain passes
 * every syntax check ever written, and the reply vanishes without a bounce
 * anyone reads.
 */

export interface EmailCheck {
  /** Safe to accept and store. False only for a hard failure. */
  valid: boolean;
  /** The normalised address, when valid. */
  email?: string;
  /** Why it was refused. Written for the person who typed it. */
  reason?: string;
  /** "Did you mean …?" — offered, never imposed. */
  suggestion?: string;
  /** Domain has a mail exchanger. `null` when DNS could not be reached. */
  mx: boolean | null;
  /** A ten-minute mailbox. */
  disposable: boolean;
  /** info@, sales@ — fine, but worth knowing it is not a person. */
  role: boolean;
}

/**
 * Deliberately not the RFC 5322 grammar, which permits quoted strings,
 * comments and nested angle brackets that no mail provider on earth issues.
 * This is the shape of an address a human types into a form.
 */
const SHAPE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

const KNOWN_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "zoho.com",
  // The UAE providers a Dubai operator is most likely to be on.
  "emirates.net.ae",
  "eim.ae",
  "etisalat.ae",
  "du.ae",
];

const DISPOSABLE = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "yopmail.com",
  "throwawaymail.com",
  "sharklasers.com",
  "trashmail.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
]);

const ROLE_LOCAL = new Set([
  "info",
  "admin",
  "sales",
  "support",
  "contact",
  "hello",
  "enquiries",
  "inquiries",
  "office",
  "reception",
  "bookings",
  "reservations",
  "no-reply",
  "noreply",
]);

/**
 * Edit distance counting a swap of two neighbours as one mistake.
 *
 * Damerau-Levenshtein (the optimal-string-alignment form), not plain
 * Levenshtein, and the difference is the whole feature: `gmial.com` is two
 * substitutions under Levenshtein and one transposition under this — and
 * transposing two letters is the most common typo there is. On the plain
 * version, the single most frequent misspelling of the single most common
 * mail domain on earth went unrecognised.
 */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;

  // Three rows: the one before last is what a transposition looks back at.
  let beforePrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1);
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j], beforePrev[j - 2] + 1);
      }
    }
    beforePrev = prev;
    prev = row;
  }
  return prev[b.length];
}

/**
 * A likely intended domain, or null.
 *
 * One edit for a short domain, two for a long one — `emirates.net.ae` can
 * absorb two typos and still be unmistakable, while at distance 2 `gmail.com`
 * would start swallowing `gmx.com`, which is a different real provider.
 */
export function suggest(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (KNOWN_DOMAINS.includes(domain)) return null;

  let best: { domain: string; d: number } | null = null;
  for (const known of KNOWN_DOMAINS) {
    const d = distance(domain, known);
    const limit = known.length > 12 ? 2 : 1;
    if (d <= limit && (!best || d < best.d)) best = { domain: known, d };
  }
  return best ? `${local}@${best.domain}` : null;
}

/** Everything that can be decided without the network. */
export function checkShape(raw: string): EmailCheck {
  const email = String(raw ?? "").trim().toLowerCase();

  if (!email) {
    return { valid: false, reason: "Enter an email address.", mx: null, disposable: false, role: false };
  }
  // The practical ceiling: 64 for the local part, 255 for the domain.
  if (email.length > 254) {
    return { valid: false, reason: "That address is too long.", mx: null, disposable: false, role: false };
  }
  if (!SHAPE.test(email)) {
    return {
      valid: false,
      reason: "That does not look like an email address.",
      suggestion: suggest(email) ?? undefined,
      mx: null,
      disposable: false,
      role: false,
    };
  }
  if (email.includes("..")) {
    return { valid: false, reason: "That address has two dots in a row.", mx: null, disposable: false, role: false };
  }

  const [local, domain] = email.split("@");
  if (local.length > 64) {
    return { valid: false, reason: "That address is too long before the @.", mx: null, disposable: false, role: false };
  }

  if (DISPOSABLE.has(domain)) {
    return {
      valid: false,
      reason: "That is a temporary mailbox. Use an address you can be reached on.",
      mx: null,
      disposable: true,
      role: false,
    };
  }

  return {
    valid: true,
    email,
    suggestion: suggest(email) ?? undefined,
    mx: null,
    disposable: false,
    role: ROLE_LOCAL.has(local),
  };
}

/**
 * The full check, including whether the domain can actually receive mail.
 *
 * A DNS failure is recorded as `mx: null` and never fails the address. The
 * network being unreachable is our problem, and turning it into "your email is
 * invalid" would reject real customers during an outage they cannot see.
 */
export async function verify(raw: string): Promise<EmailCheck> {
  const check = checkShape(raw);
  if (!check.valid || !check.email) return check;

  const domain = check.email.split("@")[1];

  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);

    if (records.length > 0) return { ...check, mx: true };

    // No MX. Some small domains accept mail on the A record instead, so this
    // is a fallback rather than a refusal.
    try {
      await dns.resolve4(domain);
      return { ...check, mx: true };
    } catch {
      return {
        ...check,
        valid: false,
        mx: false,
        reason: `${domain} cannot receive email. Check the spelling.`,
      };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOTFOUND / NXDOMAIN is the domain genuinely not existing — the single
    // most common real typo, and worth refusing.
    if (code === "ENOTFOUND" || code === "NXDOMAIN") {
      return {
        ...check,
        valid: false,
        mx: false,
        reason: `There is no domain called ${domain}. Check the spelling.`,
      };
    }
    // Anything else — timeout, SERVFAIL, no network — is ours, not theirs.
    return { ...check, mx: null };
  }
}
