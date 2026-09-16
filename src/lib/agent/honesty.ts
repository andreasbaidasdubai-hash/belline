import type { Location, Minutes, Slot, ToolTrace, VenueLanguage } from "../types";
import { minutesToClock } from "../time";
import { copy } from "../customer-copy";

/**
 * Did it say a time that nothing came back with?
 *
 * The product's central promise is that Belline never invents availability. It
 * is stated in the prompt, twice, in the imperative — and a prompt is a
 * request, not a control. Asked for a root colour tomorrow afternoon at a
 * salon whose only free slots were 09:00 to 10:15, it answered "I have 2:00,
 * 3:30 and 5:00 on Wednesday with Marie". Every one of those was invented.
 *
 * That is the worst failure this product has, worse than saying nothing: a
 * guest arrives for an appointment that does not exist, at a salon that has
 * never heard of them, and the venue finds out from the guest.
 *
 * So it is checked rather than asked for. Every clock time in a reply has to
 * appear in something a tool actually returned this conversation. Anything
 * else is not sent.
 *
 * Deliberately narrow, for the same reason `authority.ts` is: a check that
 * fires on innocent sentences gets switched off, and a control that is
 * switched off protects nobody. It looks at clock times and nothing else — not
 * prices, not durations, not names. Those are worth guarding too, and each one
 * is its own decision about what counts as a false positive.
 */

/** Which tools produce times a reply is allowed to quote. */
const SOURCES = new Set([
  "check_availability",
  "lookup_booking",
  "book",
  "change_booking",
  "join_waitlist",
  // Only the customer's own requested time, echoed. Repeating it back is not
  // availability; saying it is free is caught by the prompt and the request
  // guard below.
  "take_booking_request",
]);

/**
 * Every clock time a reply mentions, as minutes from midnight.
 *
 * Written forms only — "4:30", "4:30 PM", "5pm", "17:00". The spoken forms
 * ("half past four") belong to the voice channel, where the caller cannot
 * misread them onto a calendar, and adding them here would mean parsing
 * English numbers to guard a channel that has a different failure mode.
 */
export function timesIn(text: string, language: VenueLanguage = "en"): Minutes[] {
  const found: Minutes[] = [];

  // "17 Uhr", "9 Uhr" — German's bare hour, which needs no meridiem to be a
  // time: "Uhr" says so. "14.30 Uhr" is already caught below as 14.30.
  if (language === "de") {
    for (const m of text.matchAll(/(?<![:.\d])\b(\d{1,2})\s*Uhr\b/gi)) {
      const hour = Number(m[1]);
      if (hour <= 24) found.push((hour % 24) * 60);
    }
  }

  // 4:30, 16:30, 4:30 pm, 4.30pm
  const withMinutes = /\b(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?/gi;
  for (const m of text.matchAll(withMinutes)) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) continue;
    found.push(toMinutes(hour, minute, m[3]));
  }

  // 5pm, 5 pm, 11 a.m. — a bare hour only counts with a meridiem, because
  // "party of 6" and "for 4" are not times and there is no sentence where
  // guessing is better than missing one.
  //
  // The lookbehind is not decoration. Without it "10:00 AM" matched twice: as
  // 10:00, correctly, and again as the "00" before "AM" — which parsed to
  // midnight and made an honest reply look like an invention. A guard that
  // fires on correct sentences is one somebody switches off.
  const bareHour = /(?<![:.\d])\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)/gi;
  for (const m of text.matchAll(bareHour)) {
    const hour = Number(m[1]);
    if (hour > 12) continue;
    found.push(toMinutes(hour, 0, m[2]));
  }

  return [...new Set(found)];
}

function toMinutes(hour: number, minute: number, meridiem?: string): Minutes {
  let h = hour;
  if (meridiem) {
    const pm = /^p/i.test(meridiem);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return h * 60 + minute;
}

/** Every time a tool has handed back, across the conversation so far. */
export function timesOffered(traces: ToolTrace[]): Set<Minutes> {
  const offered = new Set<Minutes>();

  for (const trace of traces) {
    if (!SOURCES.has(trace.name) || !trace.ok) continue;
    collect(trace.output, offered);
  }
  return offered;
}

/**
 * Walk a tool result for anything time-shaped.
 *
 * Structural rather than a list of known fields: the tools return slots,
 * alternatives, bookings and confirmations in several shapes, and a guard that
 * knows only three of them fails open on the fourth — which is the direction
 * that costs a guest an appointment.
 */
function collect(value: unknown, into: Set<Minutes>): void {
  if (value == null) return;

  if (typeof value === "string") {
    // Tool results carry times as "16:30" in `time` fields.
    const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (m) into.add(Number(m[1]) * 60 + Number(m[2]));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collect(item, into);
    return;
  }

  if (typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "number" && /min$|Min$|^start|^end/.test(key)) {
        // startMin / endMin, in the engine's own units.
        if (v >= 0 && v <= 24 * 60) into.add(v);
        continue;
      }
      collect(v, into);
    }
  }
}

export interface HonestyVerdict {
  ok: boolean;
  /** Times the reply claimed that nothing returned. */
  invented: Minutes[];
  /** What a tool did return, for building an honest reply instead. */
  offered: Minutes[];
}

/**
 * The times a venue publishes: when it opens and closes, last seating, the
 * same-day cut-off.
 *
 * These are facts about the venue, not availability, and quoting them is the
 * receptionist's job. The guard treated them as inventions — "we're open 8:00
 * to 9:00 PM" came back as two invented times, and a customer asking when the
 * venue closes was told nothing was free. Staff diaries are deliberately not
 * read: someone's time off is not something a reply should be able to quote.
 */
export function publishedTimes(location: Pick<Location, "hours" | "restaurant" | "policy">): Set<Minutes> {
  const out = new Set<Minutes>();
  const walk = (value: unknown) => {
    if (value == null) return;
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value !== "object") return;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "number" && /^(start|end|lastSeating|sameDayCutoffMin)$/.test(key)) {
        if (v >= 0 && v <= 24 * 60) out.add(v);
      } else if (typeof v === "object") {
        walk(v);
      }
    }
  };
  walk(location.hours);
  walk(location.restaurant);
  walk(location.policy);
  return out;
}

/**
 * Words that make a sentence about opening hours rather than about a slot.
 *
 * A published time is only let through in a sentence that is plainly about
 * hours. "We open at 8:00" passes; "I have 8:00 tomorrow" does not, even at a
 * venue that opens at eight — an opening time offered as a free slot is
 * exactly the invention this file exists to stop.
 */
const HOURS_WORDS =
  /\b(open|opens|opening|close|closes|closed|closing|hours|until|till|last seating|last orders?|last booking|stop taking|cut-?off)\b/i;

/**
 * Words that frame a time as one the venue can give.
 *
 * Not a list of sentences that went wrong — the failure is *proposing a slot*,
 * and a proposal is a shape: a clock time sitting inside a phrase that says the
 * venue can put somebody in it. "I have 6:00", "how about 6:00", "I could fit
 * you in at 6:00" and "6:00 is free" are one move wearing four costumes.
 *
 * Two tiers, because the two callers can afford different amounts of noise.
 * `OFFER` is the precise one and applies everywhere, including venues with a
 * real diary, where a false positive deletes an honest sentence about opening
 * hours. `OFFER_WIDE` adds the looser idioms and is used only where Belline
 * can never give a time at all, so over-firing costs a clause and under-firing
 * costs a guest a slot that does not exist.
 *
 * Kept out of both: bare "open", "until" and "would", which is how an honest
 * sentence about opening hours is written.
 */
const OFFER_CORE = String.raw`fit (?:you )?in|squeeze (?:you )?in|slot (?:you )?in|get you in|i have|we have|i've got|we've got|there(?:'s| is| are)|avail(?:able|ability)|free|how about|what about|shall we say|put you (?:down|in)|pencil(?:led)?(?: you)? in|book(?:ing)? you in|(?:could|can|might be able to|should be able to) (?:do|manage|offer|fit|squeeze|see you|take you|get you)|would work|does that work|works for you`;
const OFFER_EXTRA = String.raw`earliest|latest|slot|come (?:in|by) at|see you at|offer(?:ing)? you|save you|reserve you`;

const OFFER = new RegExp(String.raw`\b(?:${OFFER_CORE})\b`, "i");
const OFFER_WIDE = new RegExp(String.raw`\b(?:${OFFER_CORE}|${OFFER_EXTRA})\b`, "i");

// ---------------------------------------------------------------------------
// The same guards, in German
// ---------------------------------------------------------------------------

/**
 * German is not a way round any of this.
 *
 * A German venue is guarded by the English patterns *and* these — a reply can
 * mix the two, and "I have 18:00" is as much an invention in a German thread.
 * The words are the same moves in German clothes: "ich hätte", "wie wäre es
 * mit", "da ist noch frei", "ich kann Sie um … eintragen". Boundaries are
 * written with `\p{L}` rather than `\b`, which knows nothing of ä, ö, ü or ß
 * and would never find "Öffnungszeiten" at all.
 *
 * English venues never read this section: their guards are the ones above,
 * byte for byte.
 */
// "Wir haben bis 18 Uhr geöffnet" is how German states opening hours, so "wir
// haben" only counts when the sentence is not about being open.
const DE_OFFER_CORE = String.raw`ich habe|ich hätte|(?:wir haben|haben wir)(?![^.!?]*(?:geöffnet|offen|geschlossen|Ruhetag|Öffnungszeit))|wir hätten|hätte ich|hätten wir|habe ich|es gibt|gibt es|frei|verfügbar|wie wäre es mit|wie wäre|was halten Sie von|passt (?:Ihnen|es Ihnen|das)|würde (?:Ihnen )?(?:das )?passen|(?:kann|könnte) (?:ich )?(?:Ihnen|Sie)|anbieten|einschieben|dazwischenschieben|eintragen|einplanen|reinnehmen|dazunehmen|vormerken`;
const DE_OFFER_EXTRA = String.raw`frühestens|spätestens|frühester|spätester|frühestmöglich|kommen Sie (?:gern |gerne )?(?:um|vorbei)|sehen uns um|reservieren`;

const L = String.raw`\p{L}\p{N}_`;
const OFFER_DE = new RegExp(String.raw`(?<![${L}])(?:${OFFER_CORE}|${DE_OFFER_CORE})(?![${L}])`, "iu");
const OFFER_WIDE_DE = new RegExp(
  String.raw`(?<![${L}])(?:${OFFER_CORE}|${OFFER_EXTRA}|${DE_OFFER_CORE}|${DE_OFFER_EXTRA})(?![${L}])`,
  "iu",
);

const NOT_OFFERING_DE = new RegExp(
  String.raw`(?<![${L}])(?:nicht|kein|keine|keinen|keinem|keiner|nie|niemals|ob|nichts|leider nicht|unmöglich)(?![${L}])`,
  "iu",
);

const HOURS_WORDS_DE = new RegExp(
  String.raw`(?<![${L}])(?:geöffnet|öffnen|öffnet|offen|Öffnungszeit(?:en)?|schließen|schließt|geschlossen|schliessen|schliesst|Ruhetag|bis|letzte (?:Bestellung|Buchung|Annahme|Behandlung)|Annahmeschluss|Küchenschluss)(?![${L}])`,
  "iu",
);

/**
 * Words that tell somebody in German they hold a booking. See CLAIM.
 *
 * "Bestätigt" is a participle and a present tense at once — "Sie sind
 * bestätigt" claims a booking, "das Team bestätigt Ihnen den Termin" promises
 * one — so the participles only count with the auxiliary that makes them a
 * fact ("ist", "sind", "habe … eingetragen"), or alone as the whole reply
 * ("Gebucht!"). A negation inside the claim ("ist nichts gebucht") unmakes it.
 */
const PARTICIPLES_DE = String.raw`bestätigt|gebucht|reserviert|eingetragen|vorgemerkt`;
const CLAIM_DE = new RegExp(
  String.raw`(?<![${L}])(?:(?:ist|sind|wurde|wurden|habe|haben|hat)(?![${L}])[^.!?]{0,60}?(?<![${L}])(?:${PARTICIPLES_DE})|^\s*(?:${PARTICIPLES_DE})|fest eingeplant|bis dann|bis (?:morgen|bald|später|nachher|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)|wir sehen uns|wir freuen uns auf (?:Sie|Ihren Besuch|Ihr Kommen)|alles erledigt|ist erledigt|ist fix|steht fest)(?![${L}])`,
  "giu",
);

/**
 * What undoes a German claim from inside it, between the auxiliary and the
 * participle: "ist noch nicht gebucht", "ist beim Team, und sobald es bestätigt".
 */
const UNMADE_DE = new RegExp(
  String.raw`(?<![${L}])(?:nicht|nichts|kein|keine|keinen|sobald|wenn|falls|sofern|bevor|erst|wird|werden)(?![${L}])`,
  "iu",
);

/** What makes a German claim word future or conditional: "sobald es bestätigt ist". */
const HEDGE_DE = new RegExp(
  String.raw`(?<![${L}])(?:wird|werden|würde|sobald|wenn|falls|sofern|nicht|nichts|noch|kein|keine|bevor|erst|muss|müsste|soll|sollte|kann|könnte)(?![${L}])`,
  "iu",
);

/**
 * The patterns one language's guard reads. German reads its own and English's.
 *
 * `negated` is German's negation, read across the whole clause rather than only
 * before the offer word: German puts "nicht" after the verb — "ich kann Sie um
 * 18 Uhr leider nicht eintragen" — where the English rule would never see it.
 */
function patterns(language: VenueLanguage) {
  return language === "de"
    ? { offer: OFFER_DE, offerWide: OFFER_WIDE_DE, notOffering: [NOT_OFFERING], negated: NOT_OFFERING_DE, hours: [HOURS_WORDS, HOURS_WORDS_DE] }
    : { offer: OFFER, offerWide: OFFER_WIDE, notOffering: [NOT_OFFERING], negated: null, hours: [HOURS_WORDS] };
}

/**
 * A refusal is not an offer. "I can't say whether 8:00 is free" contains the
 * word that makes an offer and is the opposite of one, so only the words before
 * the phrase, in the same clause, are read — the same shape as HEDGE below.
 * "will" is deliberately absent: "the team will fit you in at 5:30" is still a
 * slot Belline has no business naming.
 */
const NOT_OFFERING =
  /\b(can'?t|cannot|can not|don'?t|do not|won'?t|will not|never|not|no|unable|whether|nothing|isn'?t|aren'?t|hasn'?t|haven'?t)\b|n't\b/i;

function framesAnOffer(
  clause: string,
  re: RegExp = OFFER,
  notOffering: RegExp[] = [NOT_OFFERING],
  negated: RegExp | null = null,
): boolean {
  if (negated?.test(clause)) return false;
  for (const m of clause.matchAll(new RegExp(re.source, re.flags.includes("u") ? "giu" : "gi"))) {
    const before = clause.slice(0, m.index);
    if (!notOffering.some((no) => no.test(before))) return true;
  }
  return false;
}

/** Sentences, as a person would split them. Keeps the punctuation. */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
}

/**
 * Clauses, for a repair that has to keep half a sentence.
 *
 * The reply that prompted this was a single sentence carrying both the right
 * answer and the wrong one: "We're open Thursdays 9 to 6, so 7 PM would be
 * outside our hours — the latest we could fit you in is around 5:30 PM."
 * Dropping the sentence drops the opening hours, which were correct and useful.
 * So a dash, a semicolon, a colon or a comma before "but"/"so" is a seam a
 * repair may cut on. The separators come back in the result, so a reply nothing
 * was cut from is returned byte for byte.
 */
function clausesOf(text: string, language: VenueLanguage = "en"): { text: string; sep: string }[] {
  const parts = text.split(
    language === "de"
      ? /((?<=[.!?])\s+|\s*[—–;:]\s+|,\s+(?=(?:but|so|though|although|however|aber|also|doch|jedoch|allerdings)\b))/
      : /((?<=[.!?])\s+|\s*[—–;:]\s+|,\s+(?=(?:but|so|though|although|however)\b))/,
  );
  const out: { text: string; sep: string }[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i]?.trim()) out.push({ text: parts[i], sep: i === 0 ? "" : parts[i - 1] ?? " " });
  }
  return out;
}

export function checkTimes(
  reply: string,
  traces: ToolTrace[],
  published?: Set<Minutes>,
  /**
   * Times the customer named themselves, this turn. Their own words are as real
   * a source as a tool's: told "can I come at 7 PM?", a reply that may not
   * repeat "7 PM" cannot say it is outside the opening hours either, and
   * refusing to name their own time is worse than naming it. Allowed only where
   * the reply is not dressing it up as available — "7 PM is outside our hours"
   * passes, "7 PM is free" does not.
   */
  said?: Set<Minutes>,
  /** The venue's, from language.ts `answersIn`. German reads the German patterns as well. */
  language: VenueLanguage = "en",
): HonestyVerdict {
  const offered = timesOffered(traces);
  const invented = new Set<Minutes>();
  const p = patterns(language);
  for (const sentence of sentencesOf(reply)) {
    const aboutHours = p.hours.some((re) => re.test(sentence));
    // German judges the offer clause by clause: its negation is read across a
    // whole clause, and "um 19 Uhr sind wir nicht mehr offen, aber ich hätte 18
    // Uhr" must not let the "nicht" of the first half excuse the second.
    const parts = language === "de" ? clausesOf(sentence, language).map((c) => c.text) : [sentence];
    for (const part of parts) {
      // An opening time offered as a slot is an invention even at the venue that
      // opens then: "we're closed by then, but I could fit you in at 6:00" is a
      // promise nothing made, and the hours exemption used to wave it through.
      const offering = framesAnOffer(part, p.offer, p.notOffering, p.negated);
      for (const t of timesIn(part, language)) {
        if (offered.has(t)) continue;
        if (!offering && aboutHours && published?.has(t)) continue;
        if (!offering && said?.has(t)) continue;
        invented.add(t);
      }
    }
  }
  // A reply naming no times cannot invent one.
  return {
    ok: invented.size === 0,
    invented: [...invented],
    offered: [...offered].sort((a, b) => a - b),
  };
}

/**
 * The reply, with only the invention taken out.
 *
 * The first version threw the whole reply away and sent a fixed line instead.
 * That was safe and it was wrong: asked "what is your service?", Belline wrote
 * a good explanation and then suggested three times it had not checked — and
 * the customer received "I haven't got anything free there", three messages
 * running, to questions that were not about availability at all.
 *
 * Now the sentences that name an invented time go, the rest stays, and the
 * message ends on a question the next turn can answer honestly. Only when
 * nothing is left does the old replacement stand in.
 */
export function repairReply(
  reply: string,
  verdict: HonestyVerdict,
  /**
   * At a business that confirms its own bookings there is no diary to fall back
   * on, and the honest alternative below is not honest there: "I haven't got
   * anything free there" and "I'll tell you exactly what's free" both claim
   * knowledge of a book Belline cannot see. That is what the repair sent to a
   * request-only venue before this flag existed.
   */
  opts: { requestsOnly?: boolean; language?: VenueLanguage } = {},
): string {
  if (verdict.ok) return reply;
  const language = opts.language ?? "en";
  const noSlot = copy(language, "guard.request_no_slot");
  const invented = new Set(verdict.invented);
  const kept = sentencesOf(reply).filter((s) => !timesIn(s, language).some((t) => invented.has(t)));
  if (!kept.length) return opts.requestsOnly ? noSlot : honestAlternative(verdict, undefined, language);

  const follow = opts.requestsOnly
    ? noSlot
    : verdict.offered.length
      ? honestAlternative(verdict, undefined, language)
      : copy(language, "guard.which_day");
  return `${kept.join(" ")} ${follow}`;
}

// ---------------------------------------------------------------------------
// Request-only businesses
// ---------------------------------------------------------------------------

/**
 * Words that tell somebody they hold a booking.
 *
 * At a business that confirms its own bookings, Belline never holds one to
 * give. "See you Friday!" is as much a false confirmation as "you're booked",
 * and a guest who reads either turns up.
 */
const CLAIM =
  /\b(confirmed|booked(?: in)?|reserved|see you(?: then| on| at| soon| friday| saturday| sunday| monday| tuesday| wednesday| thursday| tomorrow| tonight)?|you'?re all set|all set|locked in|got you down|have you down|pencilled (?:you )?in)\b/gi;

/**
 * A claim word is fine after something that makes it future or conditional:
 * "the team will confirm once it's booked", "nothing is confirmed yet". Only
 * the words before the claim, in the same sentence, are read.
 */
const HEDGE = /\b(will|once|when|until|if|not|nothing|before|as soon as|yet|to be|isn't|hasn't|haven't|aren't|can't|cannot)\b|'ll\b|n't\b/i;

export interface ClaimVerdict {
  ok: boolean;
  /** The words that claimed a booking. */
  claims: string[];
}

function claimsIn(sentence: string, language: VenueLanguage = "en"): string[] {
  const found: string[] = [];
  for (const m of sentence.matchAll(CLAIM)) {
    const before = sentence.slice(0, m.index);
    if (!HEDGE.test(before) && !(language === "de" && HEDGE_DE.test(before))) found.push(m[0].toLowerCase());
  }
  if (language === "de") {
    for (const m of sentence.matchAll(CLAIM_DE)) {
      const before = sentence.slice(0, m.index);
      if (HEDGE_DE.test(before) || HEDGE.test(before) || UNMADE_DE.test(m[0])) continue;
      found.push(m[0].toLowerCase());
    }
  }
  return found;
}

export function checkRequestReply(reply: string, language: VenueLanguage = "en"): ClaimVerdict {
  const claims = sentencesOf(reply).flatMap((s) => claimsIn(s, language));
  return { ok: claims.length === 0, claims: [...new Set(claims)] };
}

export const REQUEST_HANDOVER = copy("en", "guard.request_handover");

/** The reply with every sentence that claimed a booking taken out, ending on the honest line. */
export function repairRequestReply(reply: string, verdict: ClaimVerdict, language: VenueLanguage = "en"): string {
  if (verdict.ok) return reply;
  const kept = sentencesOf(reply).filter((s) => claimsIn(s, language).length === 0);
  return [...kept, copy(language, "guard.request_handover")].join(" ");
}

/**
 * What to say having cut a proposed slot. Names no time, promises no diary, and
 * ends somewhere the next turn can go.
 */
export const REQUEST_NO_SLOT = copy("en", "guard.request_no_slot");

export interface SlotVerdict {
  ok: boolean;
  /** The clauses that offered a time, kept for the audit log. */
  offers: string[];
}

/**
 * Did it propose a slot at a business whose diary it cannot see?
 *
 * Distinct from `checkTimes`, and needed alongside it, because the two are
 * answering different questions. `checkTimes` asks where a time *came from* —
 * and at a request-only venue a time can have an impeccable source and still be
 * a promise nobody can keep: `take_booking_request` echoes the customer's own
 * time back, which licenses "8:00 PM" for the rest of the conversation, and
 * "I have 8:00 PM for you" would sail through. This asks what the reply *does*
 * with the time. Here the answer is absolute: Belline confirms nothing, so no
 * time may be framed as available, whatever licensed it.
 *
 * Stating the opening hours is untouched — those sentences frame no offer — and
 * so is repeating the time the customer asked for.
 */
export function checkSlotOffers(reply: string, language: VenueLanguage = "en"): SlotVerdict {
  const p = patterns(language);
  const offers = clausesOf(reply, language)
    .map((c) => c.text.trim())
    .filter((text) => timesIn(text, language).length > 0 && framesAnOffer(text, p.offerWide, p.notOffering, p.negated));
  return { ok: offers.length === 0, offers };
}

/** The reply with the offered slots cut out and everything else left standing. */
export function repairSlotOffers(reply: string, verdict: SlotVerdict, language: VenueLanguage = "en"): string {
  if (verdict.ok) return reply;
  const noSlot = copy(language, "guard.request_no_slot");
  const offers = new Set(verdict.offers);
  let out = "";
  let cut = false;
  for (const clause of clausesOf(reply, language)) {
    const text = clause.text.trim();
    if (offers.has(text)) {
      cut = true;
      continue;
    }
    if (!out) out = text;
    // A clause whose neighbour was cut starts a sentence rather than dangling
    // off the separator that used to join them.
    else if (cut) out = `${endStop(out)} ${text.charAt(0).toUpperCase()}${text.slice(1)}`;
    else out += `${clause.sep}${text}`;
    cut = false;
  }
  return out ? `${endStop(out)} ${noSlot}` : noSlot;
}

function endStop(text: string): string {
  const trimmed = text.replace(/[\s,;:—–]+$/, "");
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * What to say instead.
 *
 * Built from the tool's own output rather than asked for again: a second model
 * call costs a second and might invent a different set. This is the same
 * pattern as the tools themselves, where a failure carries its own recovery.
 */
export function honestAlternative(verdict: HonestyVerdict, slots?: Slot[], language: VenueLanguage = "en"): string {
  const times = (slots?.length ? slots.map((s) => s.startMin) : verdict.offered)
    .slice(0, 3)
    .map((m) => (language === "de" ? `${minutesToClock(m)} Uhr` : minutesToClock(m)));

  if (!times.length) {
    // A dead end is its own failure. The first version of this line said there
    // was nothing free and offered to take a message, which is a reasonable
    // thing to say once and a terrible thing to say to somebody who has just
    // picked a time — as it did, in the demo that found this: "the first one
    // please" answered with "I haven't got anything free there".
    //
    // It cannot promise to go and look, because nothing here will: the guard
    // replaces a reply, it does not run another turn. So it asks, and the
    // answer arrives on the next message, which is a turn that can look.
    return copy(language, "guard.nothing_free");
  }
  const list =
    times.length === 1
      ? times[0]
      : copy(language, "guard.or", { rest: times.slice(0, -1).join(", "), last: times[times.length - 1] });
  return copy(language, "guard.actually_free", { times: list });
}
