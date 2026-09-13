import type { Location, Minutes, Slot, ToolTrace } from "../types";
import { minutesToClock } from "../time";

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
]);

/**
 * Every clock time a reply mentions, as minutes from midnight.
 *
 * Written forms only — "4:30", "4:30 PM", "5pm", "17:00". The spoken forms
 * ("half past four") belong to the voice channel, where the caller cannot
 * misread them onto a calendar, and adding them here would mean parsing
 * English numbers to guard a channel that has a different failure mode.
 */
export function timesIn(text: string): Minutes[] {
  const found: Minutes[] = [];

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

/** Sentences, as a person would split them. Keeps the punctuation. */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
}

export function checkTimes(
  reply: string,
  traces: ToolTrace[],
  published?: Set<Minutes>,
): HonestyVerdict {
  const offered = timesOffered(traces);
  const invented = new Set<Minutes>();
  for (const sentence of sentencesOf(reply)) {
    const aboutHours = HOURS_WORDS.test(sentence);
    for (const t of timesIn(sentence)) {
      if (offered.has(t)) continue;
      if (aboutHours && published?.has(t)) continue;
      invented.add(t);
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
export function repairReply(reply: string, verdict: HonestyVerdict): string {
  if (verdict.ok) return reply;
  const invented = new Set(verdict.invented);
  const kept = sentencesOf(reply).filter((s) => !timesIn(s).some((t) => invented.has(t)));
  if (!kept.length) return honestAlternative(verdict);

  const follow = verdict.offered.length
    ? honestAlternative(verdict)
    : "I'll tell you exactly what's free — which day would suit you?";
  return `${kept.join(" ")} ${follow}`;
}

/**
 * What to say instead.
 *
 * Built from the tool's own output rather than asked for again: a second model
 * call costs a second and might invent a different set. This is the same
 * pattern as the tools themselves, where a failure carries its own recovery.
 */
export function honestAlternative(verdict: HonestyVerdict, slots?: Slot[]): string {
  const times = (slots?.length ? slots.map((s) => s.startMin) : verdict.offered)
    .slice(0, 3)
    .map(minutesToClock);

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
    return "I haven't got anything free there, I'm afraid. Would you like me to look at another day?";
  }
  const list =
    times.length === 1
      ? times[0]
      : `${times.slice(0, -1).join(", ")} or ${times[times.length - 1]}`;
  return `Sorry — let me be accurate about that. What I actually have is ${list}. Would any of those work?`;
}
