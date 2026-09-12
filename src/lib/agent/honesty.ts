import type { Minutes, Slot, ToolTrace } from "../types";
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

export function checkTimes(reply: string, traces: ToolTrace[]): HonestyVerdict {
  const offered = timesOffered(traces);
  const claimed = timesIn(reply);
  // A reply naming no times cannot invent one.
  const invented = claimed.filter((t) => !offered.has(t));
  return { ok: invented.length === 0, invented, offered: [...offered].sort((a, b) => a - b) };
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
