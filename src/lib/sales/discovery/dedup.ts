/**
 * Deduplication.
 *
 * Requirement §1: "Deduplicate aggressively. Do not contact the same company
 * twice through different agents." The database enforces the second half with
 * a partial unique index; this file is the first half, and it is where the
 * work actually is — the same clinic appears as "Dr. Smile Dental Clinic LLC"
 * from a directory, "Dr Smile Dental" from Places, and `drsmile.ae` from a
 * website crawl, with three differently-formatted phone numbers.
 *
 * Three independent keys, checked in order of how much we trust them:
 *
 *   domain  — strongest. Two businesses do not share a website.
 *   phone   — strong, once normalised to E.164.
 *   name+city — weakest, and only within one country. Used last, because
 *               "Dental Clinic" in Dubai is not one business.
 *
 * Everything here is pure. It is the most-tested file in the sales engine
 * because a false match silently merges two real businesses into one — losing
 * a prospect and putting the wrong company's facts in front of a person.
 */

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/**
 * A website URL reduced to the thing that identifies the business.
 *
 * Strips scheme, `www.`, port, path, query and fragment, and lowercases.
 * Returns null for anything that is not a usable hostname, so a junk column in
 * a spreadsheet cannot create a company keyed on "n/a".
 */
export function normaliseDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim().toLowerCase();
  if (!value || value === "n/a" || value === "-" || value === "none") return null;

  // Tolerate a bare domain, which is what most spreadsheets hold.
  if (!value.includes("://")) value = `https://${value}`;

  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    return null;
  }

  host = host.replace(/^www\./, "").replace(/\.$/, "");

  // A hostname with no dot is a local name, not a business website.
  if (!host.includes(".") || host.length < 4) return null;

  // Never key a company on a platform everyone shares. A hundred clinics with
  // only a Facebook page would otherwise all merge into one company.
  if (SHARED_HOSTS.has(host) || [...SHARED_HOSTS].some((h) => host.endsWith(`.${h}`))) {
    return null;
  }
  return host;
}

const SHARED_HOSTS = new Set([
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "youtube.com",
  "wa.me",
  "google.com",
  "maps.google.com",
  "goo.gl",
  "linktr.ee",
  "wixsite.com",
  "business.site",
  "sites.google.com",
  "blogspot.com",
  "wordpress.com",
]);

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

interface DialPlan {
  cc: string;
  /** Valid national-significant-number lengths, trunk 0 removed. */
  nsnLengths: number[];
}

/**
 * Only the three countries we sell into. A general phone library would be a
 * dependency and a lot of surface for a system that will never dial Brazil.
 */
const PLANS: Record<string, DialPlan> = {
  // Mobile 5X XXXXXXX, landline X XXXXXXX — 9 digits either way.
  AE: { cc: "971", nsnLengths: [9] },
  // Mobile 5X XXXXXXX (9), landline 1X XXXXXXX (9). Some legacy 8.
  SA: { cc: "966", nsnLengths: [9, 8] },
  // 9 digits nationally: 44 123 45 67 and mobiles 79 123 45 67.
  CH: { cc: "41", nsnLengths: [9] },
};

/**
 * A phone number as E.164, or null.
 *
 * Null is a real answer and a common one: "call us", "+971 4 XXX XXXX",
 * an extension, a spreadsheet cell Excel turned into a float. A null phone
 * simply does not participate in matching, which is correct — guessing would
 * merge two companies on a number neither of them has.
 */
export function normalisePhone(
  raw: string | null | undefined,
  countryCode: string | null | undefined,
): string | null {
  if (!raw) return null;

  let value = String(raw).trim();
  if (!value) return null;

  // A number with letters in it is a vanity line or a note; not ours to parse.
  if (/[a-z]/i.test(value.replace(/^tel:/i, ""))) return null;

  // Excel turns "+971 4 1234567" into "9.71412e+11" often enough to matter.
  if (/e\+/i.test(value)) return null;

  // Multiple numbers in one cell — take the first, which is the main line.
  const firstSeparator = value.search(/[,;/]|\s+or\s+/i);
  if (firstSeparator > 0) value = value.slice(0, firstSeparator);

  const hadPlus = value.trimStart().startsWith("+");
  let digits = value.replace(/\D/g, "");
  if (!digits) return null;

  // International prefix in local notation.
  if (!hadPlus && digits.startsWith("00")) digits = digits.slice(2);

  const plan = countryCode ? PLANS[countryCode.toUpperCase()] : undefined;

  if (!plan) {
    // Without a country we can only trust a number that already declared one.
    if (hadPlus && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
    return null;
  }

  // Already carries the country code.
  if (digits.startsWith(plan.cc)) {
    const nsn = digits.slice(plan.cc.length);
    return plan.nsnLengths.includes(nsn.length) ? `+${plan.cc}${nsn}` : null;
  }

  // A `+` that is not this country's code is a foreign number — keep it as
  // given rather than forcing it into the local plan.
  if (hadPlus) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  // National format with the trunk zero.
  const nsn = digits.startsWith("0") ? digits.slice(1) : digits;
  return plan.nsnLengths.includes(nsn.length) ? `+${plan.cc}${nsn}` : null;
}

// ---------------------------------------------------------------------------
// Name
// ---------------------------------------------------------------------------

/**
 * Legal and structural noise, stripped so "Smile Dental Clinic LLC" and
 * "Smile Dental Clinic" are one business.
 *
 * Ordered longest-first: "fz llc" has to go before "llc" would eat half of it.
 */
const LEGAL_SUFFIXES = [
  "fz llc",
  "fzllc",
  "fz co",
  "fzco",
  "fze",
  "l l c",
  "llc",
  "ltd",
  "limited",
  "pllc",
  "plc",
  "inc",
  "co",
  "gmbh",
  "ag",
  "sarl",
  "sa",
  "sagl",
  "kg",
  "ohg",
  "est",
  "establishment",
  "trading",
  "group",
  "holding",
  "wll",
  "cjsc",
  "jsc",
];

/** Words that identify a trade rather than a business. Removed only when the
 *  name still has something left afterwards. */
const GENERIC_WORDS = [
  "dental",
  "dentistry",
  "clinic",
  "clinics",
  "medical",
  "center",
  "centre",
  "polyclinic",
  "hospital",
  "salon",
  "spa",
  "beauty",
  "hair",
  "restaurant",
  "cafe",
  "the",
  "and",
  "for",
];

/**
 * A name reduced to its distinguishing part, for the weakest match key.
 *
 * Deliberately aggressive, and deliberately never used on its own — it is only
 * ever combined with country and city, because this reduces "The Dental Clinic"
 * and "Dental Clinic" to the same empty-ish string.
 */
export function normaliseName(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let value = raw
    .toLowerCase()
    .normalize("NFKD")
    // Strip accents so "Genève" and "Geneve" agree.
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    // Arabic and Latin both survive; everything else becomes a space.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

  if (!value) return null;

  for (const suffix of LEGAL_SUFFIXES) {
    value = value.replace(new RegExp(`(^|\\s)${suffix}(\\s|$)`, "g"), " ").trim();
  }

  const kept = value.split(/\s+/).filter((w) => w && !GENERIC_WORDS.includes(w));
  // If stripping generic words leaves nothing, the generic words *were* the
  // name — keep them rather than returning a key that matches every clinic.
  const words = kept.length > 0 ? kept : value.split(/\s+/).filter(Boolean);

  const out = words.join("");
  return out.length >= 3 ? out : null;
}

// ---------------------------------------------------------------------------
// Match keys
// ---------------------------------------------------------------------------

export interface RawCompanyIdentity {
  name: string;
  website?: string | null;
  phone?: string | null;
  countryCode?: string | null;
  city?: string | null;
}

export interface MatchKeys {
  domain: string | null;
  phoneE164: string | null;
  nameKey: string | null;
  /** Name key scoped to a place — the only form the weak key is used in. */
  namePlaceKey: string | null;
}

export function matchKeys(input: RawCompanyIdentity): MatchKeys {
  const domain = normaliseDomain(input.website);
  const phoneE164 = normalisePhone(input.phone, input.countryCode);
  const nameKey = normaliseName(input.name);

  const city = input.city
    ? input.city
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, "")
    : "";

  return {
    domain,
    phoneE164,
    nameKey,
    // Requires a country: two "almaya" clinics in Dubai and Riyadh are not
    // the same business, and the city alone does not disambiguate reliably
    // because sources disagree on "Dubai" vs "Dubai Marina".
    namePlaceKey:
      nameKey && input.countryCode ? `${input.countryCode.toUpperCase()}:${city}:${nameKey}` : null,
  };
}

export type MatchStrength = "domain" | "phone" | "name_place" | null;

/** How two identities match, if at all. Strongest wins. */
export function compare(a: MatchKeys, b: MatchKeys): MatchStrength {
  if (a.domain && b.domain && a.domain === b.domain) return "domain";
  if (a.phoneE164 && b.phoneE164 && a.phoneE164 === b.phoneE164) return "phone";
  if (a.namePlaceKey && b.namePlaceKey && a.namePlaceKey === b.namePlaceKey) return "name_place";
  return null;
}

/**
 * Merge a newly-discovered record into one we already hold.
 *
 * Fill-only: an existing non-empty value is never overwritten by a new source.
 * The first source to state a fact wins, and later sources only fill gaps.
 * The alternative — last write wins — means a thin directory listing can
 * overwrite a carefully-read website with worse data, and there is no way to
 * tell afterwards that it happened.
 */
export function mergeFill<T extends Record<string, unknown>>(existing: T, incoming: Partial<T>): T {
  const out = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null || value === undefined || value === "") continue;
    const current = out[key];
    if (current === null || current === undefined || current === "") {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}
