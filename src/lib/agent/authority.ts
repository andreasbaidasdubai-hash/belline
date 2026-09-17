import type { Location, VenueLanguage, Vertical } from "../types";
import { allowedLanguages, answersIn } from "../language";
import { copy } from "../customer-copy";
import { AUTHORITY_PHRASES } from "./guard-phrases";

/**
 * What Belline is allowed to do about a thing a caller just said.
 *
 * The product rule this encodes is that a receptionist's competence is mostly
 * knowing the edge of its own authority. Four dispositions:
 *
 *   ANSWER   — say the approved thing. "What time do you close?"
 *   ACT      — perform a booking action. "Book me Friday at four."
 *   ASK      — not enough information yet. "Which treatment?"
 *   ESCALATE — do not decide. Fetch a person, or send them elsewhere.
 *
 * ANSWER, ACT and ASK are the model's job: they need judgement, and a model
 * is better at them than a list of phrases could ever be.
 *
 * ESCALATE is different, and that is the whole reason this file exists. For a
 * handful of categories — someone describing a medical emergency, someone
 * asking for clinical advice — being wrong once is unacceptable, and "the
 * system prompt says not to" is not a control you can test, version or point
 * at during a procurement conversation. Those categories are matched here,
 * deterministically, *before* the model sees the turn. The model cannot talk
 * itself out of a rule it never gets asked about.
 *
 * The rules are deliberately narrow. A false escalation costs a booking; a
 * missed one costs considerably more, but a filter that fires on "chest of
 * drawers" would be turned off within a week, and a control that gets turned
 * off protects nobody. Narrow and trusted beats broad and disabled.
 */

export type Disposition = "answer" | "act" | "ask" | "escalate";

export interface AuthorityRule {
  id: string;
  /** Why this exists, in words a clinic owner would accept. */
  reason: string;
  /**
   * All of these must appear for the rule to fire. Grouped terms are
   * alternatives, so a rule reads "a symptom word AND an urgency word".
   */
  requires: string[][];
  /** Said verbatim. Not a hint to the model — the actual words. */
  say: string;
  /** What happens to the call afterwards. */
  then: "transfer" | "end_call" | "message";
  /**
   * Said instead of `say` when a transfer rule fires on a line that cannot put
   * anybody through — the test console, the website, or a venue with no
   * transfer number. A receptionist that says "putting you through" and then
   * hangs up has lied at the most anxious moment of the call.
   */
  sayIfNoTransfer?: string;
}

// 998 is the UAE ambulance number, and "emergency department" is what the
// hospitals here call it. The first draft said "ring 999" and "A&E", which is
// London — a caller in Dubai who did as told would have reached the police.
const EMERGENCY_ADVICE = copy("en", "authority.emergency");

// A message and a call back from the clinical team, not a live transfer: the
// person at the desk who would pick up a transfer is not a clinician either,
// and the promise made here is that a clinician rings back.
const CLINICAL_REFUSAL = copy("en", "authority.clinical");

/**
 * Symptoms that describe an emergency in progress. Paired with the urgency
 * group below so that "I get chest pain when I run" — a history, not a
 * crisis — does not trigger the same response as "my chest hurts right now".
 */
const EMERGENCY_SYMPTOMS = [
  "chest pain",
  "chest is tight",
  "chest feels tight",
  "tightness in my chest",
  "can't breathe",
  "cannot breathe",
  "short of breath",
  "trouble breathing",
  "struggling to breathe",
  "bleeding heavily",
  "won't stop bleeding",
  "will not stop bleeding",
  "passed out",
  "fainted",
  "unconscious",
  "collapsed",
  "slurred speech",
  "face has drooped",
  "numb down one side",
  "allergic reaction",
  "anaphyla",
  "throat is closing",
  "overdose",
  "took too many",
];

const HAPPENING_NOW = [
  "now",
  "right now",
  "currently",
  "at the moment",
  "since",
  "today",
  "tonight",
  "this morning",
  "this afternoon",
  "just",
  "suddenly",
  "sudden",
  "can't",
  "cannot",
  "help",
  "is",
  "am",
  "'m",
  "feel",
  "feeling",
  "started",
];

/** Asking the receptionist to make a clinical judgement. */
const CLINICAL_QUESTION = [
  "is that normal",
  "is this normal",
  "should i be worried",
  "should i worry",
  "is it infected",
  "does that sound",
  "do you think it's",
  "do you think it is",
  "what could it be",
  "what do you think is wrong",
  "is it serious",
  "should i take",
  "can i take",
  "how much should i take",
  "double the dose",
  "instead of antibiotics",
  "diagnos",
];

const CLINICAL_CONTEXT = [
  "pain",
  "hurt",
  "ache",
  "swollen",
  "swelling",
  "bleeding",
  "infection",
  "infected",
  "symptom",
  "lump",
  "rash",
  "fever",
  "temperature",
  "medication",
  "tablet",
  "antibiotic",
  "painkiller",
  "ibuprofen",
  "paracetamol",
  "prescription",
  "surgery",
  "filling",
  "extraction",
  "stitches",
  "wound",
  "treatment",
  "operation",
];

/**
 * Rules per vertical.
 *
 * A restaurant has no clinical authority to exceed, so it has no rules here —
 * a filter that fires on a diner saying "this steak is killing me" would be
 * worse than no filter at all.
 */
const RULES: Record<Vertical, AuthorityRule[]> = {
  clinic: [
    {
      id: "medical-emergency",
      reason:
        "A caller describing an emergency in progress must be sent to emergency care, not booked in. " +
        "Taking an appointment here would be the wrong answer even if the appointment were available.",
      requires: [EMERGENCY_SYMPTOMS, HAPPENING_NOW],
      say: EMERGENCY_ADVICE,
      then: "end_call",
    },
    {
      id: "clinical-advice",
      reason:
        "Reception does not interpret symptoms or advise on medication. The model is capable of " +
        "producing a confident answer here, which is exactly why it is not asked.",
      requires: [CLINICAL_QUESTION, CLINICAL_CONTEXT],
      say: CLINICAL_REFUSAL,
      then: "message",
    },
  ],
  // Dental practices run on the clinic vertical today; the rules are the same
  // ones and are applied through it.
  salon: [
    {
      id: "adverse-reaction",
      reason:
        "A reaction to a treatment is a clinical matter and a liability, and it reaches the salon " +
        "by telephone. It goes to a person every time.",
      requires: [
        ["reaction", "burnt", "burned", "blistered", "swollen", "swelling", "rash", "scalp is"],
        ["treatment", "colour", "color", "bleach", "dye", "peel", "laser", "wax", "after"],
      ],
      say: copy("en", "authority.reaction"),
      sayIfNoTransfer: copy("en", "authority.reaction_no_transfer"),
      then: "transfer",
    },
  ],
  restaurant: [],
};

// ---------------------------------------------------------------------------
// Every other language a business speaks
// ---------------------------------------------------------------------------

/**
 * The same rules, as callers put them in another language: the phrases live in
 * guard-phrases.ts, written folded (lower case, ä as ae) because the recogniser
 * and a person typing on a phone do not agree about umlauts.
 *
 * A business is protected by the English lists *and* those of every language
 * it answers in, so a caller who switches language mid-sentence is still
 * caught. The words said back are in the conversation's language, from
 * customer-copy.ts — for German, with 112 as the emergency number.
 */
function inLanguage(rule: AuthorityRule, language: VenueLanguage): AuthorityRule {
  if (language === "en") return rule;
  const says = AUTHORITY_PHRASES[language]?.says[rule.id];
  if (!says) return rule;
  return {
    ...rule,
    say: copy(language, says.say),
    ...(says.sayIfNoTransfer ? { sayIfNoTransfer: copy(language, says.sayIfNoTransfer) } : {}),
  };
}

/** Lower case, the language's letters folded, punctuation gone: how its lists are written. */
function fold(said: string, pairs: readonly (readonly [string, string])[]): string {
  let folded = said.toLowerCase();
  for (const [from, to] of pairs) folded = folded.split(from).join(to);
  return ` ${folded.replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ")} `;
}

export interface Assessment {
  disposition: Disposition;
  rule: AuthorityRule;
}

function hasAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/**
 * Decide whether this turn is one the model may handle at all.
 *
 * Returns an escalation when a rule fires, and null otherwise — null meaning
 * "the model's judgement applies", which is the overwhelming majority of
 * turns. Nothing here tries to classify a booking or a question; that is what
 * the model is for.
 *
 * `current` is the conversation's language, when it has settled on one: the
 * words said back are in it. Otherwise the business's main language.
 */
export function assessAuthority(location: Location, said: string, current?: VenueLanguage | null): Assessment | null {
  const text = ` ${said.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ")} `;
  const reads = allowedLanguages(location);
  const says = answersIn(location, { current });

  for (const rule of RULES[location.vertical] ?? []) {
    if (rule.requires.every((group) => hasAny(text, group))) {
      return { disposition: "escalate", rule: inLanguage(rule, says) };
    }
  }

  for (const language of reads) {
    const phrases = language === "en" ? undefined : AUTHORITY_PHRASES[language];
    if (!phrases) continue;
    const folded = fold(said, phrases.fold);
    for (const rule of RULES[location.vertical] ?? []) {
      const requires = phrases.requires[rule.id];
      if (requires?.every((group) => hasAny(folded, group))) {
        return { disposition: "escalate", rule: inLanguage(rule, says) };
      }
    }
  }
  return null;
}

/** Every rule a venue is currently protected by — for the dashboard, and for procurement. */
export function authorityRules(location: Location): AuthorityRule[] {
  const rules = RULES[location.vertical] ?? [];
  const main = answersIn(location);
  return main === "en" ? rules : rules.map((rule) => inLanguage(rule, main));
}
