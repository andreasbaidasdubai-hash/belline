/**
 * Who Belline is, in law.
 *
 * One block, two consumers. `scripts/build-site.ts` fills the privacy and
 * terms pages from it, and the outreach engine puts it in the footer of every
 * cold email and refuses to send into Germany, Austria or Switzerland until it
 * is complete. Two copies of this would drift, and the direction it would
 * drift in is the one where a German recipient gets an email from a company
 * that does not name itself.
 *
 * Nothing here is a credential. It is public information that belongs on a
 * letterhead, so it lives in the repository where a reviewer can see whether
 * it is filled in. Each field can still be overridden by an environment
 * variable, which is how staging runs with a placeholder without anybody
 * editing the file that production reads.
 */

export interface LegalIdentity {
  /** The registered company, exactly as on the trade licence or Handelsregister. */
  entity: string;
  /** Its registered postal address, on one line. */
  address: string;
  /** Governing law and courts, for the terms page. */
  law: string;
  /**
   * The same governing law in German. It completes a German sentence, so the
   * English wording cannot be dropped in.
   */
  lawDe: string;
  /**
   * The natural person or persons who represent the company.
   *
   * § 5 TMG (now § 5 DDG) requires this of anyone doing business by email in
   * Germany, and Austria (§ 5 ECG) and Switzerland (Art. 3(1)(s) UWG) ask for
   * substantially the same. It is why DACH is off until this is filled.
   */
  managingDirector: string;
  /** Commercial register entry, trade licence number or equivalent. */
  registration: string;
  /** VAT / tax number, where one exists. Optional everywhere we send. */
  vatNumber: string;
  /** A monitored address a recipient can actually write to. */
  email: string;
}

/**
 * The real values. Empty means not yet formed.
 *
 * Filling `entity`, `address`, `managingDirector`, `registration` and `email`
 * is what switches DACH sending from refused to possible. Do not fill one of
 * them with a plausible-looking placeholder to make a screen go green.
 */
export const LEGAL: LegalIdentity = {
  entity: "",
  address: "",
  law: "",
  lawDe: "",
  managingDirector: "",
  registration: "",
  vatNumber: "",
  email: "hello@belline.ai",
};

const ENV_KEYS: Record<keyof LegalIdentity, string> = {
  entity: "LEGAL_ENTITY",
  address: "LEGAL_ADDRESS",
  law: "LEGAL_LAW",
  lawDe: "LEGAL_LAW_DE",
  managingDirector: "LEGAL_MANAGING_DIRECTOR",
  registration: "LEGAL_REGISTRATION",
  vatNumber: "LEGAL_VAT_NUMBER",
  email: "LEGAL_EMAIL",
};

export type Env = Record<string, string | undefined>;

/**
 * The identity as this process sees it: the block above, with any field an
 * environment variable names taking precedence.
 */
export function legalIdentity(env: Env = process.env): LegalIdentity {
  const out = { ...LEGAL };
  for (const key of Object.keys(ENV_KEYS) as (keyof LegalIdentity)[]) {
    const value = env[ENV_KEYS[key]]?.trim();
    if (value) out[key] = value;
  }
  // The postal address already had a home before this file existed, and the
  // outreach templates read it. Honour it rather than making the founder set
  // the same string twice.
  if (!out.address) out.address = env.SENDER_POSTAL_ADDRESS?.trim() ?? "";
  return out;
}

/** The environment variable that would fill a field, for an error message. */
export function legalEnvKey(field: keyof LegalIdentity): string {
  return ENV_KEYS[field];
}

/**
 * Which of the named fields are still empty.
 *
 * Returns the field names, not a sentence, so callers can both explain the
 * gap to a member of staff and record it against a refused send.
 */
export function missingIdentityFields(
  identity: LegalIdentity,
  required: readonly (keyof LegalIdentity)[],
): (keyof LegalIdentity)[] {
  return required.filter((field) => !identity[field]?.trim());
}

const FIELD_WORDS: Record<keyof LegalIdentity, string> = {
  entity: "the registered company name",
  address: "the registered postal address",
  law: "the governing law",
  lawDe: "the governing law in German",
  managingDirector: "the managing director",
  registration: "the commercial register or trade licence number",
  vatNumber: "the VAT number",
  email: "a monitored contact address",
};

/** The same gap, as something a person can act on. */
export function describeIdentityGaps(fields: readonly (keyof LegalIdentity)[]): string {
  if (fields.length === 0) return "";
  const words = fields.map((f) => `${FIELD_WORDS[f]} (${ENV_KEYS[f]})`);
  const last = words.pop()!;
  return words.length ? `${words.join(", ")} and ${last}` : last;
}

/**
 * A short, stable fingerprint of the identity used for a given send.
 *
 * Recorded on every sent item. If a complaint arrives in eighteen months we
 * can say which version of our own letterhead the message carried, without
 * storing the whole block on every row.
 */
export function identityFingerprint(identity: LegalIdentity): string {
  const canonical = [
    identity.entity,
    identity.address,
    identity.managingDirector,
    identity.registration,
    identity.vatNumber,
    identity.email,
  ]
    .map((s) => s.trim())
    .join("|");
  // Not a security boundary — a content hash, so djb2 rather than a crypto
  // import this module does not otherwise need.
  let hash = 5381;
  for (let i = 0; i < canonical.length; i++) hash = ((hash << 5) + hash + canonical.charCodeAt(i)) >>> 0;
  return `id_${hash.toString(36)}`;
}

/** True when nothing at all has been filled in — used to say "not formed yet". */
export function identityIsEmpty(identity: LegalIdentity): boolean {
  return !identity.entity && !identity.managingDirector && !identity.registration;
}
