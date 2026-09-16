import type { Location, RequestRules } from "../types";
import { MARKETS, MARKET_CODES, type Market } from "../markets";
import { takesRequestsOnly } from "../booking/destination";
import { defaultRequestRules } from "../booking/requests";
import { requireE164 } from "../phone";

/**
 * The rules step: what Belline asks for, who it puts urgent calls through to,
 * and what it must never say.
 *
 * The transfer number is a toll-fraud control as much as a setting. Belline
 * pays for the leg it dials, so the number has to be in the venue's own
 * country and not a premium-rate line; a typo, or a hijacked account, must not
 * turn every urgent call into an international one.
 */

interface Dialling {
  code: string;
  /** Digits after the country code, without a trunk 0. */
  digits: [number, number];
  premium?: RegExp;
}

const DIALLING: Record<Market, Dialling> = {
  AE: { code: "971", digits: [8, 9], premium: /^900/ },
  GB: { code: "44", digits: [9, 10], premium: /^9/ },
  AU: { code: "61", digits: [9, 9], premium: /^19/ },
  CA: { code: "1", digits: [10, 10], premium: /^900/ },
  US: { code: "1", digits: [10, 10], premium: /^900/ },
  SG: { code: "65", digits: [8, 8] },
  IE: { code: "353", digits: [7, 9], premium: /^15/ },
  NZ: { code: "64", digits: [8, 10], premium: /^900/ },
  CH: { code: "41", digits: [9, 9], premium: /^90/ },
  // German and Austrian numbers vary in length by area; 0900 and 090x/093x are premium rate.
  DE: { code: "49", digits: [6, 11], premium: /^900/ },
  AT: { code: "43", digits: [6, 12], premium: /^9[03]/ },
};

/** Which country a venue is in: its plan's market, else its currency and clock. */
export function venueMarket(location: Pick<Location, "subscription" | "currency" | "timezone">): Market {
  if (location.subscription?.market) return location.subscription.market;
  const exact = MARKET_CODES.find((m) => MARKETS[m].currency === location.currency && MARKETS[m].timezone === location.timezone);
  return exact ?? MARKET_CODES.find((m) => MARKETS[m].currency === location.currency) ?? "AE";
}

export type PhoneCheck = { ok: true; e164: string } | { ok: false; reason: string };

/** A number Belline may put a call through to, in E.164, or why not. */
export function checkTransferNumber(raw: string, market: Market): PhoneCheck {
  const info = MARKETS[market];
  const rule = DIALLING[market];
  const text = raw.trim();
  if (!text) return { ok: false, reason: "Enter a phone number." };
  if (/[^\d\s()+.\-]/.test(text)) {
    return { ok: false, reason: `That does not look like a phone number. Type digits only, starting +${rule.code}.` };
  }

  let digits = text.replace(/\D/g, "");
  const international = text.startsWith("+") || digits.startsWith("00");
  if (!text.startsWith("+") && digits.startsWith("00")) digits = digits.slice(2);

  let national: string;
  if (international) {
    if (!digits.startsWith(rule.code)) {
      return {
        ok: false,
        reason: `That number is outside ${info.name}. Belline only puts calls through to numbers in ${info.name}, so a mistyped number cannot run up international call charges.`,
      };
    }
    national = digits.slice(rule.code.length);
  } else {
    national = digits;
  }
  // The trunk 0 of a national number, and the "(0)" people write after +44.
  national = national.replace(/^0/, "");

  const [min, max] = rule.digits;
  if (national.length < min || national.length > max) {
    return { ok: false, reason: `That number has the wrong number of digits for ${info.name}. Check it and try again.` };
  }
  if (rule.premium?.test(national)) {
    return { ok: false, reason: "Calls cannot be put through to a premium-rate number. Use a landline or mobile." };
  }
  return { ok: true, e164: `+${rule.code}${national}` };
}

/** May Belline dial this venue's transfer number right now? */
export function transferAllowed(location: Location, number: string): boolean {
  return checkTransferNumber(number, venueMarket(location)).ok;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface RulesInput {
  askFor?: unknown;
  transferNumber?: unknown;
  notify?: unknown;
  afterHours?: unknown;
  neverSay?: unknown;
}

export type RulesResult = { ok: true; location: Location } | { ok: false; field: keyof RulesInput; error: string };

/**
 * Apply what the owner typed on the rules step. A field left out of the body
 * keeps what was saved; a field sent empty clears it.
 */
export function applyRules(location: Location, input: RulesInput, now: Date = new Date()): RulesResult {
  const o = location.onboarding ?? { version: 1 as const, channels: {} };
  const market = venueMarket(location);
  const escalation = { ...o.escalation };
  const agent = { ...location.agent };

  if (input.transferNumber !== undefined) {
    const raw = String(input.transferNumber ?? "").trim();
    if (raw) {
      // With its country code, always: the field converts a local entry with
      // the country picked beside it, and a request made by hand without one is
      // refused here. Then the toll-fraud rule: a number in the venue's country.
      const strict = requireE164(raw);
      if (!strict.ok) return { ok: false, field: "transferNumber", error: strict.reason };
      const check = checkTransferNumber(strict.e164, market);
      if (!check.ok) return { ok: false, field: "transferNumber", error: check.reason };
      escalation.transferNumber = check.e164;
      agent.transferNumber = check.e164;
    } else {
      delete escalation.transferNumber;
      agent.transferNumber = "";
    }
  }

  if (input.notify !== undefined) {
    const raw = String(input.notify ?? "").trim();
    delete escalation.notifyEmail;
    delete escalation.notifyWhatsApp;
    if (raw.includes("@")) {
      if (!EMAIL.test(raw) || raw.length > 200) return { ok: false, field: "notify", error: "That email address does not look right." };
      escalation.notifyEmail = raw.toLowerCase();
    } else if (raw) {
      // The owner's own WhatsApp: with its country code, and in the venue's
      // country, the same rule as the urgent-call number.
      const strict = requireE164(raw);
      if (!strict.ok) return { ok: false, field: "notify", error: `For WhatsApp alerts: ${strict.reason}` };
      const check = checkTransferNumber(strict.e164, market);
      if (!check.ok) return { ok: false, field: "notify", error: `For WhatsApp alerts: ${check.reason}` };
      escalation.notifyWhatsApp = check.e164;
    }
  }

  let requestRules: RequestRules | undefined = o.requestRules;
  if (takesRequestsOnly(location) || input.askFor !== undefined || input.afterHours !== undefined || input.neverSay !== undefined) {
    const base = o.requestRules ?? defaultRequestRules(location);
    const allowed = location.vertical === "restaurant" ? ["partySize"] : ["service"];
    const askFor =
      input.askFor === undefined
        ? base.askFor
        : (Array.isArray(input.askFor) ? input.askFor : []).filter((v): v is RequestRules["askFor"][number] => allowed.includes(String(v)));
    const afterHours = input.afterHours === undefined ? base.afterHours : input.afterHours === "message" ? "message" : "request";
    let neverSay = base.neverSay;
    if (input.neverSay !== undefined) {
      const lines = String(input.neverSay ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length > 10) return { ok: false, field: "neverSay", error: "Keep it to ten lines or fewer." };
      if (lines.some((l) => l.length > 200)) return { ok: false, field: "neverSay", error: "Keep each line under 200 characters." };
      neverSay = lines;
    }
    requestRules = { askFor: [...new Set(askFor)], afterHours, neverSay };
  }

  return {
    ok: true,
    location: {
      ...location,
      agent,
      onboarding: { ...o, escalation, ...(requestRules ? { requestRules } : {}), rulesConfirmedAt: now.toISOString() },
    },
  };
}
