/**
 * What kind of thing just arrived.
 *
 * Three questions, and the first is the one the whole pipeline turns on:
 *
 *  1. **Is this a person?** An out-of-office is not a reply. It is evidence
 *     that the address is live and that nobody has read the message — the two
 *     facts that most argue for writing again later. Treating it as a reply
 *     stops the sequence for good and loses the lead, silently, with no error
 *     anywhere. This is the most expensive mistake this file can make, so the
 *     detection leans on headers, which are declarations, before it leans on
 *     wording, which is a guess.
 *
 *  2. **Is this a bounce?** A delivery report from a mail system, not a human
 *     reply. Permanent ones suppress; temporary ones do not, because a mailbox
 *     that was full on Tuesday is not a person who asked to be left alone.
 *
 *  3. **Did somebody ask to be left alone in prose?** "Take me off your list"
 *     is not a click on an unsubscribe link, and the honest answer is that
 *     sometimes we can tell and sometimes we cannot. So there are three
 *     verdicts, not two: act, ask a person, or do nothing. The middle one
 *     exists because both wrong guesses are bad — suppressing a company that
 *     wanted a call, or writing again to somebody who told us to stop.
 *
 * Nothing here calls a model. Every rule is a pattern somebody can read, argue
 * with and change, and a classifier whose behaviour changes under us is not
 * something to put between a person saying stop and our writing to them again.
 */

import { looksLikeOptOut } from "../compliance/suppression";
import type { ParsedMessage } from "./mime";
import type { InboundKind, OptOutConfidence } from "../sending/store";

export interface Classification {
  kind: InboundKind;
  /** Why, in the words a member of staff would want on the screen. */
  why: string;
  optOut: OptOutConfidence;
  /** The phrase that triggered an opt-out verdict, for the review screen. */
  optOutPhrase: string | null;
  /**
   * When an auto-reply says they are back. Null when it is an auto-reply that
   * gave no date — the caller applies its own default rather than this file
   * inventing one.
   */
  backAt: Date | null;
  /** A permanent failure: suppress the address. */
  permanentFailure: boolean;
  failedRecipient: string | null;
}

// ---------------------------------------------------------------------------
// Auto-replies
// ---------------------------------------------------------------------------

/**
 * Headers that say "a machine sent this", in the sender's own words.
 *
 * RFC 3834 exists precisely so this does not have to be guesswork, and every
 * serious mail system sets at least one of these. Checked first and trusted:
 * a false positive here pauses a sequence for a week, a false negative stops
 * it forever.
 */
const AUTO_HEADERS: { name: string; test: (value: string) => boolean; why: string }[] = [
  { name: "auto-submitted", test: (v) => !/^no$/i.test(v.trim()), why: "Auto-Submitted header" },
  { name: "x-autoreply", test: () => true, why: "X-Autoreply header" },
  { name: "x-autorespond", test: () => true, why: "X-Autorespond header" },
  { name: "x-auto-response-suppress", test: () => true, why: "X-Auto-Response-Suppress header" },
  { name: "x-ms-exchange-inbox-rules-loop", test: () => true, why: "an Exchange auto-reply rule" },
  { name: "precedence", test: (v) => /auto[_-]?reply|auto[_-]?generated/i.test(v), why: "Precedence header" },
  { name: "x-precedence", test: (v) => /auto/i.test(v), why: "X-Precedence header" },
];

/** Subjects mail systems give their own auto-replies, in our four languages. */
const AUTO_SUBJECTS: RegExp[] = [
  /\bauto(?:matic)?[ -]?reply\b/i,
  /\bout of (?:the )?office\b/i,
  /\bofficeprofile\b/i,
  /\bautomatische antwort\b/i,
  /\babwesenheit(?:snotiz)?\b/i,
  /\bnicht im b(?:ü|ue)ro\b/i,
  /\br(?:é|e)ponse automatique\b/i,
  /\babsence du bureau\b/i,
  /\bرد\s*تلقائي\b/,
  /\bخارج\s*المكتب\b/,
];

/** Wording, used only when the headers said nothing. Weaker, so it needs more. */
const AUTO_BODY: RegExp[] = [
  /\bout of (?:the )?office\b/i,
  /\bon (?:annual |parental |sick )?leave\b/i,
  /\baway from (?:my|the) (?:desk|office)\b/i,
  /\bcurrently (?:away|unavailable|travelling|traveling)\b/i,
  /\bi will (?:be )?(?:back|return)(?:ing)? on\b/i,
  /\bwill be answered (?:on|after)\b/i,
  /\bich bin (?:derzeit |zurzeit |momentan )?(?:nicht im b(?:ü|ue)ro|abwesend|au(?:ß|ss)er haus)\b/i,
  /\bbin (?:bis|ab) .{0,30} (?:zur(?:ü|ue)ck|wieder erreichbar)\b/i,
  /\bje suis (?:actuellement )?absent/i,
  /\bde retour le\b/i,
  /\bأنا\s+خارج\s+المكتب\b/,
];

// ---------------------------------------------------------------------------
// Bounces
// ---------------------------------------------------------------------------

const BOUNCE_SENDERS = /^(?:mailer-daemon|postmaster|no-?reply|double-?bounce)@/i;
const BOUNCE_SUBJECTS: RegExp[] = [
  /\bundelivered mail returned to sender\b/i,
  /\bdelivery status notification\b/i,
  /\bmail delivery (?:failed|subsystem)\b/i,
  /\bundeliverable\b/i,
  /\breturned mail\b/i,
  /\bunzustellbar\b/i,
  /\b(?:é|e)chec de (?:la )?(?:remise|distribution)\b/i,
];

// ---------------------------------------------------------------------------
// Opt-out in prose
// ---------------------------------------------------------------------------

/**
 * Phrases that probably mean stop, but not certainly.
 *
 * Separate from the list in `compliance/suppression.ts`, which is the
 * authoritative one and acts on its own. These get a human instead. Each of
 * them can appear in a message that is not an opt-out at all — "how did you
 * get my email" is sometimes the first line of a conversation — and guessing
 * either way is worse than a note in somebody's queue.
 */
const MAYBE_OPT_OUT: RegExp[] = [
  /\bnot interested\b/i,
  /\bno thank(?:s| you)\b/i,
  /\bdelete (?:my|our) (?:details|data|address|information)\b/i,
  /\bremove (?:my|our|this) (?:details|data|address|email|e-mail)\b/i,
  /\bfrom your (?:database|records|mailing list)\b/i,
  /\bhow did you get (?:my|our)\b/i,
  /\bwe (?:do not|don't) accept unsolicited\b/i,
  /\bwrong (?:person|address|contact)\b/i,
  /\bno longer (?:works? here|with (?:the|this) (?:company|practice|clinic))\b/i,
  /\bkein interesse\b/i,
  /\bnicht interessiert\b/i,
  /\bl(?:ö|oe)schen sie (?:meine|unsere)\b/i,
  /\bpas int(?:é|e)ress(?:é|e)\b/i,
  /\bلسنا?\s+مهتم/,
];

// ---------------------------------------------------------------------------
// When are they back
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, januar: 0, janvier: 0,
  feb: 1, february: 1, februar: 1, "février": 1, fevrier: 1,
  mar: 2, march: 2, "märz": 2, maerz: 2, mars: 2,
  apr: 3, april: 3, avril: 3,
  may: 4, mai: 4,
  jun: 5, june: 5, juni: 5, juin: 5,
  jul: 6, july: 6, juli: 6, juillet: 6,
  aug: 7, august: 7, "août": 7, aout: 7,
  sep: 8, sept: 8, september: 8, septembre: 8,
  oct: 9, october: 9, oktober: 9, octobre: 9,
  nov: 10, november: 10, novembre: 10,
  dec: 11, december: 11, dezember: 11, "décembre": 11, decembre: 11,
};

/**
 * The date an auto-reply says they are back, if it says one at all.
 *
 * Only dates that are in the future and within a season of now are believed. A
 * message quoting last year's holiday, or a signature with a date in it, would
 * otherwise set a resume moment in the past — which resumes immediately and
 * makes the pause useless — or one in 2031, which loses the lead as surely as
 * stopping would.
 */
export function returnDate(text: string, now: Date): Date | null {
  const window = text.slice(0, 4000);
  const candidates: Date[] = [];
  const push = (y: number, m: number, d: number) => {
    const at = new Date(Date.UTC(y, m, d, 9, 0, 0));
    if (Number.isFinite(at.getTime())) candidates.push(at);
  };

  // 2026-10-05
  for (const m of window.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)) {
    push(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  // 05.10.2026 and 05/10/2026 — day first, which is the European convention
  // these three languages share. An American mm/dd would be read as a later
  // date in the same month, which errs towards waiting, not towards writing.
  for (const m of window.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](20\d{2}|\d{2})\b/g)) {
    const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    push(year, Number(m[2]) - 1, Number(m[1]));
  }
  // 5 October / 5. Oktober / October 5
  const names = Object.keys(MONTHS).join("|");
  for (const m of window.matchAll(new RegExp(`\\b(\\d{1,2})\\.?\\s+(${names})\\b`, "gi"))) {
    push(now.getUTCFullYear(), MONTHS[m[2].toLowerCase()], Number(m[1]));
  }
  for (const m of window.matchAll(new RegExp(`\\b(${names})\\s+(\\d{1,2})\\b`, "gi"))) {
    push(now.getUTCFullYear(), MONTHS[m[1].toLowerCase()], Number(m[2]));
  }

  const soonest = candidates
    .map((d) => {
      // A bare "5 October" written in December means next year.
      if (d.getTime() < now.getTime() - 30 * 86_400_000) {
        return new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate(), 9));
      }
      return d;
    })
    .filter((d) => d.getTime() > now.getTime() && d.getTime() < now.getTime() + 120 * 86_400_000)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return soonest ?? null;
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export interface ClassifyInput {
  message: ParsedMessage;
  /** SES's own verdict, when it gave one. */
  now?: Date;
}

export function classify(input: ClassifyInput): Classification {
  const { message } = input;
  const now = input.now ?? new Date();
  const text = message.text;
  const subject = message.subject ?? "";

  const base: Classification = {
    kind: "reply",
    why: "a person wrote back",
    optOut: "none",
    optOutPhrase: null,
    backAt: null,
    permanentFailure: false,
    failedRecipient: null,
  };

  // --- a feedback report: somebody pressed "this is spam" -------------------
  if (/message\/feedback-report/i.test(message.contentType) || message.headers.get("x-abuse-report") !== null) {
    return { ...base, kind: "complaint", why: "an abuse feedback report" };
  }

  // --- a bounce -------------------------------------------------------------
  const fromDaemon = message.from !== null && BOUNCE_SENDERS.test(message.from);
  const bounceSubject = BOUNCE_SUBJECTS.some((p) => p.test(subject));
  if (message.report || (fromDaemon && bounceSubject) || (message.isDeliveryReport && bounceSubject)) {
    const report = message.report;
    return {
      ...base,
      kind: "bounce",
      why: report?.diagnostic?.slice(0, 200) ?? (report?.status ? `delivery status ${report.status}` : subject || "a delivery report"),
      // With no machine-readable report, the safe reading of a bounce-shaped
      // message is "temporary": suppressing an address on a subject line is
      // how a real prospect is deleted because their server had a bad hour.
      permanentFailure: report?.permanent ?? false,
      failedRecipient: report?.recipient ?? null,
    };
  }

  // --- an auto-reply --------------------------------------------------------
  let autoWhy: string | null = null;
  for (const header of AUTO_HEADERS) {
    const value = message.headers.get(header.name);
    if (value !== null && header.test(value)) {
      autoWhy = header.why;
      break;
    }
  }
  if (!autoWhy && AUTO_SUBJECTS.some((p) => p.test(subject))) autoWhy = "the subject line";
  if (!autoWhy && AUTO_BODY.some((p) => p.test(text))) autoWhy = "what it says";
  // An empty envelope sender is how a mail system says "do not reply to this".
  if (!autoWhy && /^<?>?$/.test((message.headers.get("return-path") ?? "x").trim())) {
    autoWhy = "an empty Return-Path";
  }

  if (autoWhy) {
    return {
      ...base,
      kind: "auto_reply",
      why: `an automatic reply — ${autoWhy}`,
      backAt: returnDate(text, now),
    };
  }

  // --- a person, and possibly one asking to be left alone -------------------
  //
  // Read against the stripped text, never the quoted history: our own footer
  // carries the word "unsubscribe", and a friendly reply with our message
  // quoted underneath would otherwise suppress the company for good.
  if (looksLikeOptOut(text)) {
    return { ...base, optOut: "certain", optOutPhrase: firstMatch(text, null), why: "they asked to be taken off" };
  }
  const maybe = MAYBE_OPT_OUT.find((p) => p.test(text));
  if (maybe) {
    return {
      ...base,
      optOut: "likely",
      optOutPhrase: firstMatch(text, maybe),
      why: "they may be asking to be taken off — a person should read this one",
    };
  }

  return base;
}

/** The sentence a pattern matched in, trimmed for a table cell. */
function firstMatch(text: string, pattern: RegExp | null): string | null {
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  if (!pattern) return sentences.find((s) => looksLikeOptOut(s))?.trim().slice(0, 200) ?? null;
  return sentences.find((s) => pattern.test(s))?.trim().slice(0, 200) ?? null;
}
