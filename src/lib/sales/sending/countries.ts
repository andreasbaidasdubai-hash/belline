/**
 * Per-country sending rules.
 *
 * Not a hook and not a comment. A lead's country decides, in code, whether it
 * may be written to at all, how many go out that day, how long between
 * touches, how many touches there may ever be, which language the footer is
 * in, and which parts of the sender identity must be filled before the first
 * message can leave.
 *
 * The reason this is a mechanism rather than a note in a runbook: the failure
 * it prevents is silent. Nobody notices that a Munich clinic got a fourth
 * follow-up in English with no Impressum until a letter arrives. A rule that
 * lives in a table and is consulted on every single send cannot be forgotten
 * on a busy Tuesday.
 *
 * Adding a country is adding a row. The default row is deliberately
 * conservative rather than permissive: an unknown country is off.
 */

import type { LegalIdentity } from "../../legal/identity";

export interface CountryRule {
  /** ISO-3166 alpha-2, or `*` for the fallback. */
  code: string;
  label: string;
  /**
   * Whether cold email is on here before any member of staff touches a
   * setting. UAE yes; DACH no, by the founder's decision and the law's.
   */
  enabledByDefault: boolean;
  /** Ceiling on first-touch sends into this country per day, across all mailboxes. */
  dailyCap: number;
  /** Days that must pass between two messages to the same company. */
  minDaysBetweenTouches: number;
  /**
   * Messages in one sequence: the first demo email plus its follow-ups.
   * 4 in the Gulf (first + three follow-ups); 3 in DACH (first + two).
   */
  maxSequenceSteps: number;
  /** Messages to one company in any rolling 90 days, across every agent. */
  companyTouchCap90d: number;
  /** The language the frame, footer and unsubscribe wording are written in. */
  language: string;
  /**
   * Parts of the sender identity that must be non-empty before a single
   * message may go to this country.
   */
  requiresIdentity: readonly (keyof LegalIdentity)[];
  /**
   * The legal basis or regime this send is made under, recorded on the item.
   * If a complaint arrives we can show what rule we believed applied.
   */
  basis: string;
  /** Why this country is off by default, shown to staff before they turn it on. */
  caution?: string;
}

/**
 * The address fields any recipient anywhere must be able to see.
 *
 * Every regime we send into wants a real postal identity in the footer, so
 * this is the floor rather than a Gulf-specific rule.
 */
const EVERYWHERE: readonly (keyof LegalIdentity)[] = ["address"];

/**
 * What German, Austrian and Swiss commercial email must name.
 *
 * § 5 DDG (formerly § 5 TMG) in Germany and § 5 ECG in Austria require the
 * entity, its address, the people who represent it, the register entry and a
 * contact address. Switzerland's UWG Art. 3(1)(s) requires correct sender
 * details and a working opt-out. None of that is satisfiable by a company that
 * does not exist yet, which is precisely why these fields gate the send.
 *
 * Exported because the outreach privacy notice needs exactly the same five to
 * name its controller under Art. 13/14, and check-mail-privacy pins the two
 * lists together so a field added here cannot be forgotten there.
 */
export const DACH_IDENTITY: readonly (keyof LegalIdentity)[] = [
  "entity",
  "address",
  "managingDirector",
  "registration",
  "email",
];

export const COUNTRY_RULES: readonly CountryRule[] = [
  {
    code: "*",
    label: "Everywhere else",
    enabledByDefault: false,
    dailyCap: 0,
    minDaysBetweenTouches: 4,
    maxSequenceSteps: 3,
    companyTouchCap90d: 4,
    language: "en",
    requiresIdentity: EVERYWHERE,
    basis: "unclassified — no country rule written",
    caution:
      "No rule has been written for this country, so nothing is known about what its law requires. Write a rule before turning it on.",
  },
  {
    code: "AE",
    label: "United Arab Emirates",
    enabledByDefault: true,
    dailyCap: 240,
    minDaysBetweenTouches: 3,
    maxSequenceSteps: 4,
    companyTouchCap90d: 6,
    language: "en",
    requiresIdentity: EVERYWHERE,
    basis: "UAE — business-to-business, identified sender, one-click opt-out honoured permanently",
  },
  {
    code: "SA",
    label: "Saudi Arabia",
    enabledByDefault: false,
    dailyCap: 60,
    minDaysBetweenTouches: 4,
    maxSequenceSteps: 3,
    companyTouchCap90d: 4,
    language: "en",
    requiresIdentity: EVERYWHERE,
    basis: "KSA — business-to-business, identified sender",
    caution: "The Saudi anti-spam regime expects registration of the sender. Take advice before turning this on.",
  },
  {
    code: "DE",
    label: "Germany",
    enabledByDefault: false,
    dailyCap: 60,
    minDaysBetweenTouches: 7,
    maxSequenceSteps: 3,
    companyTouchCap90d: 3,
    language: "de",
    requiresIdentity: DACH_IDENTITY,
    basis: "DE — § 7 UWG presumed-interest basis for B2B, § 5 DDG sender identification",
    caution:
      "§ 7(2) UWG treats unsolicited commercial email as an unreasonable nuisance without prior consent. The business-to-business reading rests on a presumed interest in the specific offer and has never been tested for us. § 5 DDG additionally requires the full sender identification below.",
  },
  {
    code: "AT",
    label: "Austria",
    enabledByDefault: false,
    dailyCap: 40,
    minDaysBetweenTouches: 7,
    maxSequenceSteps: 3,
    companyTouchCap90d: 3,
    language: "de",
    requiresIdentity: DACH_IDENTITY,
    basis: "AT — § 107 TKG, § 5 ECG sender identification",
    caution:
      "§ 107 TKG is stricter than Germany: unsolicited commercial email generally needs prior consent, and there is a public opt-out list (the ECG-Liste) this engine does not screen against.",
  },
  {
    code: "CH",
    label: "Switzerland",
    enabledByDefault: false,
    dailyCap: 40,
    minDaysBetweenTouches: 7,
    maxSequenceSteps: 3,
    companyTouchCap90d: 3,
    language: "de",
    requiresIdentity: DACH_IDENTITY,
    basis: "CH — UWG Art. 3(1)(o) and (s): correct sender details and a working refusal channel",
    caution:
      "UWG Art. 3(1)(o) makes mass unsolicited advertising without consent a criminal matter, not merely a civil one. The exception for existing customers does not apply to anyone in a cold list.",
  },
];

/** The rule for a country code, falling back to the deliberately-off default. */
export function ruleFor(countryCode: string | null | undefined): CountryRule {
  const code = (countryCode ?? "").trim().toUpperCase();
  return COUNTRY_RULES.find((r) => r.code === code) ?? COUNTRY_RULES[0];
}

/** Rules with a real country code, for the settings screen. */
export function realRules(): CountryRule[] {
  return COUNTRY_RULES.filter((r) => r.code !== "*");
}

/**
 * A staff override of the default, stored per country.
 *
 * Staff may turn a country on or down. They may not turn a rule's spacing,
 * step cap or identity requirements off, because those are the parts a busy
 * person would be most tempted to loosen and the parts that carry the
 * liability.
 */
export interface CountryOverride {
  code: string;
  enabled: boolean;
  /** Lower than the rule's cap only. A higher number is clamped. */
  dailyCap?: number | null;
  updatedBy?: string;
  updatedAt?: string;
}

export interface EffectiveCountry extends CountryRule {
  enabled: boolean;
  /** True when a person turned this on, rather than it being on by default. */
  enabledByStaff: boolean;
  effectiveDailyCap: number;
}

export function effectiveRule(
  countryCode: string | null | undefined,
  overrides: readonly CountryOverride[] = [],
): EffectiveCountry {
  const rule = ruleFor(countryCode);
  const override = overrides.find((o) => o.code.toUpperCase() === rule.code);
  const enabled = override ? override.enabled : rule.enabledByDefault;
  // Clamped, never raised. A settings screen is not the place to widen a limit
  // that exists because of a statute.
  const asked = override?.dailyCap ?? rule.dailyCap;
  const effectiveDailyCap = Math.max(0, Math.min(asked, rule.dailyCap));
  return {
    ...rule,
    enabled,
    enabledByStaff: Boolean(override && override.enabled && !rule.enabledByDefault),
    effectiveDailyCap: enabled ? effectiveDailyCap : 0,
  };
}
