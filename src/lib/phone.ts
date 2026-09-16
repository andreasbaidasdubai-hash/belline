/**
 * Phone numbers an owner types, with their country code, always.
 *
 * Founder, 2026-09-16: "always make sure the clients need to give the country
 * code so everything is correct." A number saved as 0502992339 means one thing
 * in Dubai and another in London, and Belline dials, forwards and matches by
 * number. So every phone field in setup and the dashboard has a country picker
 * beside it (defaulting to the business's own market), converts a local entry
 * with that country, refuses anything it cannot resolve at the field, and the
 * server stores E.164 only.
 *
 * Pure: the fields run it in the browser and the routes run it again.
 */

export interface Country {
  /** ISO 3166 alpha-2. */
  iso: string;
  name: string;
  /** Country calling code, digits only. */
  dial: string;
  /** Digits after the code, without a trunk 0. */
  digits: [number, number];
  /** Whether numbers here are written with a trunk 0 at home (050…, 020…). */
  trunk0: boolean;
}

/** The markets first, then the countries owners and their teams most often have numbers in. */
export const COUNTRIES: readonly Country[] = [
  { iso: "AE", name: "United Arab Emirates", dial: "971", digits: [8, 9], trunk0: true },
  { iso: "GB", name: "United Kingdom", dial: "44", digits: [9, 10], trunk0: true },
  { iso: "AU", name: "Australia", dial: "61", digits: [9, 9], trunk0: true },
  { iso: "US", name: "United States", dial: "1", digits: [10, 10], trunk0: false },
  { iso: "CA", name: "Canada", dial: "1", digits: [10, 10], trunk0: false },
  { iso: "SG", name: "Singapore", dial: "65", digits: [8, 8], trunk0: false },
  { iso: "IE", name: "Ireland", dial: "353", digits: [7, 9], trunk0: true },
  { iso: "NZ", name: "New Zealand", dial: "64", digits: [8, 10], trunk0: true },
  { iso: "CH", name: "Switzerland", dial: "41", digits: [9, 9], trunk0: true },
  { iso: "SA", name: "Saudi Arabia", dial: "966", digits: [9, 9], trunk0: true },
  { iso: "QA", name: "Qatar", dial: "974", digits: [8, 8], trunk0: false },
  { iso: "KW", name: "Kuwait", dial: "965", digits: [8, 8], trunk0: false },
  { iso: "BH", name: "Bahrain", dial: "973", digits: [8, 8], trunk0: false },
  { iso: "OM", name: "Oman", dial: "968", digits: [8, 8], trunk0: false },
  { iso: "IN", name: "India", dial: "91", digits: [10, 10], trunk0: true },
  { iso: "PK", name: "Pakistan", dial: "92", digits: [10, 10], trunk0: true },
  { iso: "PH", name: "Philippines", dial: "63", digits: [10, 10], trunk0: true },
  { iso: "EG", name: "Egypt", dial: "20", digits: [9, 10], trunk0: true },
  { iso: "LB", name: "Lebanon", dial: "961", digits: [7, 8], trunk0: true },
  { iso: "FR", name: "France", dial: "33", digits: [9, 9], trunk0: true },
  { iso: "DE", name: "Germany", dial: "49", digits: [6, 11], trunk0: true },
];

/** A business's own country from its currency, where no market is to hand. Dirhams and anything unknown: the UAE. */
export function countryForCurrency(currency: string | undefined): string {
  const byCurrency: Record<string, string> = { AED: "AE", GBP: "GB", AUD: "AU", CAD: "CA", USD: "US", SGD: "SG", NZD: "NZ", CHF: "CH", SAR: "SA", QAR: "QA", KWD: "KW", BHD: "BH", OMR: "OM", INR: "IN" };
  return byCurrency[(currency ?? "").toUpperCase()] ?? "AE";
}

export function countryByIso(iso: string | undefined): Country | undefined {
  return COUNTRIES.find((c) => c.iso === iso);
}

/** The country a stored E.164 number belongs to, when it is one of ours. Longest code wins; +1 is read as the US. */
export function countryOfE164(e164: string): Country | undefined {
  const digits = e164.replace(/\D/g, "");
  return [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length).find((c) => digits.startsWith(c.dial));
}

export type PhoneResult = { ok: true; e164: string } | { ok: false; reason: string };

const E164 = /^\+[1-9]\d{7,14}$/;

/** Strictly E.164, as stored: a plus, a country code, 8 to 15 digits in all, nothing else. */
export function isE164(value: string): boolean {
  return E164.test(value);
}

/**
 * What the owner typed, with the country chosen beside it, as E.164.
 *
 *   +44 20 7946 0958 / 0044 20 7946 0958   the code is in the number: it wins
 *   050 299 2339 with United Arab Emirates  +971502992339
 *   502992339 with United Arab Emirates     +971502992339
 *   0502992339 with no country              refused: nothing says which country
 */
export function normaliseOwnerPhone(raw: string, iso: string | undefined): PhoneResult {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "Enter a phone number." };
  if (/[^\d\s()+.\-/]/.test(text) || (text.match(/\+/g) ?? []).length > 1 || (text.includes("+") && !text.startsWith("+"))) {
    return { ok: false, reason: "That does not look like a phone number. Use digits, with the country code." };
  }
  let digits = text.replace(/\D/g, "");
  const international = text.startsWith("+") || digits.startsWith("00");
  if (!text.startsWith("+") && digits.startsWith("00")) digits = digits.slice(2);

  if (international) {
    const e164 = `+${digits}`;
    if (!isE164(e164)) return { ok: false, reason: "That number has the wrong number of digits. Check it, with the country code." };
    const known = countryOfE164(e164);
    if (known) {
      // "(0)" after the code, as people write +44 (0)20…
      let national = digits.slice(known.dial.length);
      if (known.trunk0 && national.startsWith("0")) national = national.slice(1);
      const [min, max] = known.digits;
      if (national.length < min || national.length > max) {
        return { ok: false, reason: `That number has the wrong number of digits for ${known.name}. Check it and try again.` };
      }
      return { ok: true, e164: `+${known.dial}${national}` };
    }
    return { ok: true, e164 };
  }

  const country = countryByIso(iso);
  if (!country) return { ok: false, reason: "Choose the country for this number, or type it with its country code (+…)." };
  let national = digits;
  if (country.trunk0 && national.startsWith("0")) national = national.slice(1);
  // Somebody typed the code without the plus: 971502992339.
  if (national.startsWith(country.dial) && national.length - country.dial.length >= country.digits[0]) {
    const rest = national.slice(country.dial.length);
    if (rest.length <= country.digits[1]) national = rest.startsWith("0") && country.trunk0 ? rest.slice(1) : rest;
  }
  const [min, max] = country.digits;
  if (national.length < min || national.length > max) {
    return { ok: false, reason: `That number has the wrong number of digits for ${country.name}. Check it and try again.` };
  }
  return { ok: true, e164: `+${country.dial}${national}` };
}

/**
 * The server's rule for a number an owner saves: E.164 only. A field sends
 * E.164 because it converts at the field; anything else is refused, so a
 * request made by hand cannot store a number without its country code.
 */
export function requireE164(raw: unknown): PhoneResult {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "Enter a phone number." };
  const compact = text.replace(/[\s()\-.]/g, "");
  if (!compact.startsWith("+")) return { ok: false, reason: "Include the country code, for example +971 50 123 4567." };
  return normaliseOwnerPhone(compact, undefined);
}

/** A stored number shown back, grouped and international: +971 50 299 2339. */
export function formatInternational(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!value.trim().startsWith("+") || digits.length < 8) return value;
  const country = countryOfE164(`+${digits}`);
  if (!country) return `+${digits}`;
  const national = digits.slice(country.dial.length);
  let groups: string[];
  if (country.iso === "AE") {
    groups = national.length === 9 ? [national.slice(0, 2), national.slice(2, 5), national.slice(5)] : [national.slice(0, 1), national.slice(1, 4), national.slice(4)];
  } else if (country.dial === "1" && national.length === 10) {
    groups = [national.slice(0, 3), national.slice(3, 6), national.slice(6)];
  } else {
    const head = national.length - 4;
    groups = [];
    for (let i = 0; i < head; i += 3) groups.push(national.slice(i, Math.min(i + 3, head)));
    groups.push(national.slice(head));
  }
  return `+${country.dial} ${groups.filter(Boolean).join(" ")}`;
}

/**
 * A number already stored, read for a field: E.164 as it is, and an older
 * local-format one normalised with the business's own country, so it keeps
 * working and is shown with its code. Unreadable values come back as typed.
 */
export function readStoredPhone(value: string | undefined, defaultIso: string): { country: string; text: string; e164: string | null } {
  const text = (value ?? "").trim();
  if (!text) return { country: defaultIso, text: "", e164: null };
  const out = normaliseOwnerPhone(text, defaultIso);
  if (!out.ok) return { country: defaultIso, text, e164: null };
  const country = countryOfE164(out.e164);
  return { country: country?.iso ?? defaultIso, text: formatInternational(out.e164), e164: out.e164 };
}
