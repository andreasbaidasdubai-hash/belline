/**
 * The gate.
 *
 * Every message passes through `screen()` twice: once when a batch is built,
 * so staff see what is blocked and why before they approve anything, and again
 * in the second before it is handed to a provider, because an approval can be
 * hours old and an opt-out can arrive in between.
 *
 * It is a pure function of facts the caller has already gathered. That is the
 * whole design: a rule expressed as a database query inside a send loop is a
 * rule nobody can test, and the rules here are the ones that must not have a
 * bug — the difference between "we send to the wrong person" and "we commit an
 * offence in Switzerland" is a boolean.
 *
 * The order matters and is not alphabetical. Suppression outranks everything,
 * including a staff override, because an opt-out is the one decision that is
 * not ours to revisit.
 */

import type { LegalIdentity } from "../../legal/identity";
import { describeIdentityGaps, missingIdentityFields } from "../../legal/identity";
import type { EffectiveCountry } from "./countries";

export type BlockCode =
  | "suppressed"
  | "no_address"
  | "no_demo"
  | "no_research"
  | "country_off"
  | "identity_incomplete"
  | "sequence_stopped"
  | "step_cap"
  | "touch_cap"
  | "too_soon"
  | "no_unsubscribe"
  | "no_privacy_notice"
  | "guard_flags"
  | "engine_inert";

export interface Block {
  code: BlockCode;
  /** Said to a member of staff, not to a log. */
  reason: string;
}

export interface ScreenInput {
  companyName: string;
  toAddress: string | null;
  countryCode: string | null;
  country: EffectiveCountry;
  identity: LegalIdentity;
  /** A reason string from the suppression list, or null. */
  suppressed: string | null;
  /** The step about to be sent: 1 is the first demo email. */
  step: number;
  /** Outbound messages to this company in the last 90 days, from anywhere. */
  touches90d: number;
  /** When this company was last written to, or null. */
  lastTouchAt: string | null;
  /** The prepared personalised demo link. Missing means no send, ever. */
  hasDemoLink: boolean;
  /** A research record exists for the company. */
  hasResearch: boolean;
  /** The lead's sequence has already stopped — replied, clicked, bounced. */
  sequenceStopped: string | null;
  /** Guard problems on the drafted copy. A flagged draft never sends. */
  guardProblems: readonly string[];
  /** False when no unsubscribe secret is configured, so no link can be signed. */
  canSignUnsubscribe: boolean;
  /**
   * False when the privacy notice for this recipient cannot be published —
   * the company has no name, address or representative to put on it
   * (`src/lib/legal/outreach-privacy.ts`).
   *
   * Separate from `identity_incomplete`, which asks whether this country's
   * law requires the sender to be identified. This asks whether the Art.
   * 13/14 notice exists at all, and the answer is the same in every country
   * whose recipients have those rights.
   */
  hasPrivacyNotice: boolean;
  /** False when no sending adapter resolved — the engine is inert. */
  engineReady: boolean;
  now?: Date;
}

export interface ScreenResult {
  ok: boolean;
  blocks: Block[];
  /** Recorded on the item so a complaint can be answered from the row. */
  basis: string;
  language: string;
}

const DAY_MS = 86_400_000;

export function screen(input: ScreenInput): ScreenResult {
  const blocks: Block[] = [];
  const now = input.now ?? new Date();
  const add = (code: BlockCode, reason: string) => blocks.push({ code, reason });

  // 1. Suppression. First, always, and not overridable by anything below.
  if (input.suppressed) {
    add("suppressed", `on the suppression list — ${input.suppressed}`);
  }

  // 2. Can we even address it.
  if (!input.toAddress || !input.toAddress.includes("@")) {
    add("no_address", "no email address");
  }

  // 3. Is this country open, and are we fit to write into it.
  if (!input.country.enabled) {
    add(
      "country_off",
      input.country.code === "*"
        ? `no sending rule has been written for ${input.countryCode ?? "this country"}`
        : `${input.country.label} is switched off for cold email`,
    );
  }
  const gaps = missingIdentityFields(input.identity, input.country.requiresIdentity);
  if (gaps.length > 0) {
    add(
      "identity_incomplete",
      `${input.country.label} requires the sender to be identified, and we are missing ` +
        `${describeIdentityGaps(gaps)}`,
    );
  }

  // 4. Is there something worth sending.
  if (!input.hasDemoLink) {
    add("no_demo", "no prepared demo link — the email's only job is to earn one click on it");
  }
  if (!input.hasResearch) {
    add("no_research", "no research record, so nothing in the message would be about them");
  }
  if (input.guardProblems.length > 0) {
    add("guard_flags", `the copy failed a guard: ${input.guardProblems[0]}`);
  }

  // 5. Have we already said enough.
  if (input.sequenceStopped) {
    add("sequence_stopped", `the sequence stopped: ${input.sequenceStopped}`);
  }
  if (input.step > input.country.maxSequenceSteps) {
    add(
      "step_cap",
      `step ${input.step} is past the ${input.country.maxSequenceSteps}-message limit for ${input.country.label}`,
    );
  }
  if (input.touches90d >= input.country.companyTouchCap90d) {
    add(
      "touch_cap",
      `${input.touches90d} messages to this company in 90 days, and the cap for ${input.country.label} is ` +
        `${input.country.companyTouchCap90d}`,
    );
  }
  if (input.lastTouchAt) {
    const days = (now.getTime() - Date.parse(input.lastTouchAt)) / DAY_MS;
    if (Number.isFinite(days) && days < input.country.minDaysBetweenTouches) {
      add(
        "too_soon",
        `last written to ${Math.floor(days)} day${Math.floor(days) === 1 ? "" : "s"} ago; ` +
          `${input.country.label} needs ${input.country.minDaysBetweenTouches}`,
      );
    }
  }

  // 6. Can we offer a way out, and is there anything that can send.
  if (!input.canSignUnsubscribe) {
    add("no_unsubscribe", "no unsubscribe secret is configured, so no opt-out link can be signed");
  }
  if (!input.hasPrivacyNotice) {
    add(
      "no_privacy_notice",
      "the privacy notice for people we write to uninvited cannot be published yet, so there is nothing to link to — " +
        "and Art. 13/14 want that notice at first contact, not on request",
    );
  }
  if (!input.engineReady) {
    add("engine_inert", "no sending credentials are configured, so the engine is inert");
  }

  return {
    ok: blocks.length === 0,
    blocks,
    basis: input.country.basis,
    language: input.country.language,
  };
}

/** The first blocking reason, for a table cell. */
export function firstReason(result: ScreenResult): string | null {
  return result.blocks[0]?.reason ?? null;
}

/**
 * Whether a block is something staff could clear, or something only the world
 * can clear. Used to sort the "blocked" list on the approval screen so the
 * actionable ones are at the top.
 */
export function isActionable(code: BlockCode): boolean {
  return (
    code === "no_demo" ||
    code === "no_research" ||
    code === "guard_flags" ||
    code === "country_off" ||
    code === "identity_incomplete" ||
    code === "no_unsubscribe" ||
    code === "no_privacy_notice" ||
    code === "engine_inert"
  );
}
