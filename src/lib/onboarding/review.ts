import type { Faq, Minutes, TimeRange, Vertical, WeeklyHours } from "../types";
import { parseClock } from "../time";
import { formatInternational, normaliseOwnerPhone, requireE164 } from "../phone";

/**
 * The setup review, as data.
 *
 * The review screen used to be a read-only list under a heading that said
 * "change anything that is wrong", and saving sent back the address, the phone
 * and the policies. The hours, the staff and the prices the owner had just
 * typed were dropped on the floor: a restaurant open 12:00 to 23:30 stayed
 * open 09:00 to 18:00.
 *
 * So the form is built, checked and turned into the saved body here, in plain
 * functions with no store and no React, which lets the page, the API route and
 * the checks all use the same code. The hours are parsed with the same clock
 * and day helpers Belle's set_hours tool uses, so "Sat–Thu 10–10" means the
 * same thing typed into the form as said to Belle.
 */

// ---------------------------------------------------------------------------
// Days and hours
// ---------------------------------------------------------------------------

export const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ALL = [0, 1, 2, 3, 4, 5, 6];

/** "weekdays", "every day", "sat", 5 → day numbers, Sunday = 0. Null for a word that is not a day. */
export function dayIndexes(raw: unknown): number[] | null {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = new Set<number>();
  for (const item of list) {
    const word = String(item ?? "").trim().toLowerCase();
    if (word === "every day" || word === "everyday" || word === "daily") ALL.forEach((d) => out.add(d));
    // The UAE working week.
    else if (word === "weekdays") [1, 2, 3, 4, 5].forEach((d) => out.add(d));
    else if (word === "weekend" || word === "weekends") [0, 6].forEach((d) => out.add(d));
    else if (/^[0-6]$/.test(word)) out.add(Number(word));
    else {
      const i = DAYS.findIndex((d) => d.startsWith(word.slice(0, 3)) && word.length >= 3);
      if (i < 0) return null;
      out.add(i);
    }
  }
  return [...out].sort();
}

/** "sat-thu" wraps through the week; "mon, wed and fri" is a list. */
function daysIn(text: string): number[] | null {
  const words = text
    .replace(/\b(on|from|and|open|opening|hours?|is|are|we're|we are)\b/g, " ")
    .replace(/\s*-\s*/g, "-")
    .split(/[\s,/]+/)
    .filter(Boolean);
  if (!words.length) return null;
  const joined = words.join(" ");
  if (/^(every ?day|daily|7 days( a week)?|all week)$/.test(joined)) return [...ALL];

  const out = new Set<number>();
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === "every" && words[i + 1] === "day") {
      ALL.forEach((d) => out.add(d));
      i++;
      continue;
    }
    if (word === "7" || word === "days" || word === "a" || word === "week") continue;
    const range = word.split("-");
    if (range.length === 2) {
      const from = dayIndexes(range[0]);
      const to = dayIndexes(range[1]);
      if (!from || !to || from.length !== 1 || to.length !== 1) return null;
      for (let d = from[0]; ; d = (d + 1) % 7) {
        out.add(d);
        if (d === to[0]) break;
      }
      continue;
    }
    const one = dayIndexes(word);
    if (!one) return null;
    one.forEach((d) => out.add(d));
  }
  return out.size ? [...out].sort() : null;
}

const TIME = String.raw`(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?|noon|midday|midnight)`;
const RANGE = new RegExp(`${TIME}\\s*-\\s*${TIME}`, "g");

function clock(raw: string, closing: boolean, opening?: Minutes): Minutes | null {
  const t = raw.trim();
  if (t === "noon" || t === "midday") return 12 * 60;
  if (t === "midnight") return 24 * 60;
  let m = parseClock(t);
  if (m === null && /^\d{1,2}$/.test(t)) {
    const h = Number(t);
    if (h > 24) return null;
    m = h * 60;
    // "10–10" is ten in the morning to ten at night; "9-6" closes at six in
    // the evening. A bare closing hour at or before the opening is afternoon.
    if (closing && opening !== undefined && m <= opening && h < 12) m += 12 * 60;
  }
  if (m === 0 && closing) return 24 * 60;
  return m;
}

export type HoursParse = { ok: true; hours: WeeklyHours } | { ok: false; error: string };

/**
 * Opening hours as people write them.
 *
 *   "12:00–23:30 every day"   "Sat–Thu 10–10"   "Mon-Fri 9am-6pm; Sat 10-4; closed Sundays"
 *
 * Clauses are read in order and a later one wins for the days it names, so
 * "every day 10-22, closed Fridays" is closed on Friday. Days no clause names
 * are closed. An hour that closes before it opens is refused, not guessed.
 */
export function parseHours(input: string): HoursParse {
  const text = input
    .toLowerCase()
    .replace(/[–—−]/g, "-")
    .replace(/\s+(to|till|until|til)\s+/g, "-")
    .replace(/\b(\d{1,2})\s*h\b/g, "$1")
    .trim();
  if (!text) return { ok: false, error: "Type the opening hours, like 10:00-20:00 every day." };

  const clauses = text
    .split(/[;\n]|,(?=\s*(?:closed|every|daily|weekdays?|weekends?|sun|mon|tue|wed|thu|fri|sat))|\.\s+/)
    .map((c) => c.trim())
    .filter(Boolean);

  const hours: WeeklyHours = Object.fromEntries(ALL.map((d) => [d, []]));
  const named = new Set<number>();

  for (const clause of clauses) {
    if (/\bclosed\b/.test(clause)) {
      const days = daysIn(clause.replace(/\bclosed\b/g, " ").replace(/\b(\w{3,}day)s\b/g, "$1"));
      if (!days) return { ok: false, error: `Which days is "${clause}"?` };
      for (const d of days) {
        hours[d] = [];
        named.add(d);
      }
      continue;
    }

    const ranges: TimeRange[] = [];
    for (const match of clause.matchAll(RANGE)) {
      const start = clock(match[1], false);
      const end = start === null ? null : clock(match[2], true, start);
      if (start === null || end === null) return { ok: false, error: `"${match[0]}" is not a time Belline can read.` };
      if (end <= start) return { ok: false, error: `In "${clause}", closing is before the opening time.` };
      ranges.push({ start, end });
    }
    if (!ranges.length) return { ok: false, error: `"${clause}" has no times in it. Try 10:00-20:00.` };

    const rest = clause.replace(RANGE, " ").replace(/\b(\w{3,}day)s\b/g, "$1").replace(/[,&]/g, " ").trim();
    const days = rest ? daysIn(rest) : [...ALL];
    if (!days) return { ok: false, error: `Which days is "${clause}"?` };
    ranges.sort((a, b) => a.start - b.start);
    for (const d of days) {
      hours[d] = ranges.map((r) => ({ ...r }));
      named.add(d);
    }
  }

  return { ok: true, hours };
}

function hhmm(m: Minutes): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Hours back into words that `parseHours` reads to the same thing. Week shown Monday first. */
export function formatHours(hours: WeeklyHours): string {
  const key = (d: number) => (hours[d] ?? []).map((r) => `${hhmm(r.start)}-${hhmm(r.end)}`).join(" and ");
  if (ALL.every((d) => key(d) === key(0))) return key(0) ? `Every day ${key(0)}` : "Closed every day";

  const order = [1, 2, 3, 4, 5, 6, 0];
  const parts: string[] = [];
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && key(order[j + 1]) === key(order[i])) j++;
    const days = i === j ? SHORT[order[i]] : `${SHORT[order[i]]}-${SHORT[order[j]]}`;
    parts.push(key(order[i]) ? `${days} ${key(order[i])}` : `${days} closed`);
    i = j + 1;
  }
  return parts.join("; ");
}

/** Hours from a request body, trusted for nothing: day keys 0-6, whole minutes, start before end. */
export function cleanHours(raw: unknown): WeeklyHours | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: WeeklyHours = {};
  for (const d of ALL) {
    const list = (raw as Record<string, unknown>)[String(d)];
    if (list === undefined) {
      out[d] = [];
      continue;
    }
    if (!Array.isArray(list) || list.length > 4) return null;
    const ranges: TimeRange[] = [];
    for (const r of list) {
      const start = Number((r as TimeRange)?.start);
      const end = Number((r as TimeRange)?.end);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 * 60 || end <= start) return null;
      ranges.push({ start, end });
    }
    out[d] = ranges.sort((a, b) => a.start - b.start);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sources and confidence
// ---------------------------------------------------------------------------

/** Where a value on the review came from. */
export type Source = "website" | "documents" | "both" | "typed" | "saved";

export function sourceLabel(source: Source, fileName?: string): string {
  switch (source) {
    case "website":
      return "from your website";
    case "documents":
      return fileName ? `from ${fileName}` : "from your documents";
    case "both":
      return "from your website and documents";
    case "typed":
      return "you typed";
    case "saved":
      return "already saved";
  }
}

export type Confidence = "clear" | "check" | "missing";

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  clear: "Looks complete",
  check: "Please check",
  missing: "Not found",
};

/**
 * How sure the review is about a value. Not the model's opinion of itself: a
 * plain look at the value. An address with no number in it, a service with no
 * price or hours that do not read are marked for checking.
 */
export function confidenceOf(field: "address" | "hours" | "price" | "text", value: string | number, source: Source): Confidence {
  const empty = typeof value === "number" ? !(value > 0) : !String(value).trim();
  if (empty) return "missing";
  if (source === "typed" || source === "saved") return "clear";
  if (field === "address") return /\d/.test(String(value)) && String(value).length > 10 ? "clear" : "check";
  if (field === "hours") return parseHours(String(value)).ok ? "check" : "missing";
  return "clear";
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

export interface Field<T> {
  value: T;
  source: Source;
}

export interface ServiceRow {
  name: string;
  durationMin: number;
  price: number;
  source: Source;
}

export interface ReviewForm {
  name: Field<string>;
  greeting: Field<string>;
  address: Field<string>;
  phone: Field<string>;
  /** The country picked beside the phone (ISO), which a local entry is read with. Unset: the business's own market. */
  phoneCountry?: string;
  /** Written as words; parsed on save and previewed as you type. */
  hours: Field<string>;
  /** Bookable services, or a restaurant's menu. */
  services: ServiceRow[];
  staff: Field<string>[];
  faqs: (Faq & { source: Source })[];
  /** One per line. */
  policies: Field<string>;
}

/** What the venue has now, as the page hands it to the form. */
export interface CurrentVenue {
  name: string;
  vertical: Vertical;
  greeting: string;
  address: string;
  phone: string;
  hours: WeeklyHours;
  services: { name: string; durationMin: number; price: number }[];
  staff: string[];
  faqs: Faq[];
  policies: string[];
}

/** What the reader found, the shape POST /api/setup returns in `draft.found`. */
export interface Found {
  name: string;
  greeting: string;
  address: string;
  hours?: string;
  services: { name: string; durationMin: number; price: number }[];
  staff: string[];
  faqs: Faq[];
}

/** The question every restaurant's menu is filed under, so the agent can find it. */
export const MENU_QUESTION = "What is on the menu, and what does it cost?";

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The review form, prefilled.
 *
 * Read values first, then anything already saved that the reader did not
 * find, so running setup a second time never quietly drops a service or an
 * FAQ somebody added by hand. With no draft (setting up by hand) it is the
 * venue as it stands, which for a new account is nearly empty.
 */
export function formFromDraft(found: Found | null, read: Source, current: CurrentVenue): ReviewForm {
  const src = (v: unknown): Source => (found && (typeof v === "string" ? v.trim() : Array.isArray(v) ? v.length : v) ? read : "saved");

  const services: ServiceRow[] = (found?.services ?? []).map((s) => ({
    name: s.name,
    durationMin: Math.round(Number(s.durationMin) || 0),
    price: Math.max(0, Number(s.price) || 0),
    source: read,
  }));
  for (const s of current.services) if (!services.some((x) => same(x.name, s.name))) services.push({ ...s, source: "saved" });

  const staff: Field<string>[] = (found?.staff ?? []).map((name) => ({ value: name, source: read }));
  for (const name of current.staff) if (!staff.some((x) => same(x.value, name))) staff.push({ value: name, source: "saved" });

  const faqs = (found?.faqs ?? []).map((f) => ({ q: f.q, a: f.a, source: read }));
  for (const f of current.faqs) {
    if (f.q === MENU_QUESTION) continue;
    if (!faqs.some((x) => same(x.q, f.q))) faqs.push({ ...f, source: "saved" });
  }

  const readHours = found?.hours?.trim();
  const parsed = readHours ? parseHours(readHours) : null;

  return {
    name: { value: found?.name?.trim() || current.name, source: src(found?.name) },
    greeting: { value: found?.greeting?.trim() || current.greeting, source: src(found?.greeting) },
    address: { value: found?.address?.trim() || current.address, source: src(found?.address) },
    // Shown back international and grouped, as it is stored: +971 50 299 2339.
    phone: { value: current.phone.trim().startsWith("+") ? formatInternational(current.phone) : current.phone, source: "saved" },
    hours: readHours
      ? { value: parsed?.ok ? formatHours(parsed.hours) : readHours, source: read }
      : { value: formatHours(current.hours), source: "saved" },
    services,
    staff,
    faqs,
    policies: { value: current.policies.join("\n"), source: "saved" },
  };
}

export interface SaveBody {
  name: string;
  greeting: string;
  address: string;
  phone: string;
  hours: WeeklyHours;
  services: { name: string; durationMin: number; price: number }[];
  staff: string[];
  faqs: Faq[];
  policies: string[];
}

/**
 * One thing that stops the review being saved, and the field it is about.
 *
 * `id` is the id of the input on the review screen, so the page puts the
 * message directly under that input, marks it invalid and moves focus to it.
 * "How long does X take?" printed at the bottom of a long form was answered in
 * whichever box happened to sit nearest the message.
 */
export interface FieldError {
  id: string;
  message: string;
}

/** The review screen's input ids, shared so an error and its input cannot drift apart. */
export const REVIEW_IDS = {
  phone: "review-phone",
  hours: "review-hours",
  serviceMinutes: (i: number) => `review-service-${i}-minutes`,
  faqQuestion: (i: number) => `review-faq-${i}-q`,
  faqAnswer: (i: number) => `review-faq-${i}-a`,
} as const;

/**
 * What the review needs to know about where bookings go.
 *
 * `lengthsRequired` is booking/destination.ts `serviceLengthsRequired` for the
 * venue: only a business Belline books into itself needs to say how long each
 * service takes. Unset means required, the safe answer for a caller that did
 * not ask.
 */
export interface ReviewOptions {
  lengthsRequired?: boolean;
  /** The business's own market (ISO), for a phone typed without its country code. */
  country?: string;
}

/** The business phone as E.164, or why not. Empty is allowed. */
function reviewPhone(form: ReviewForm, opts: ReviewOptions): { e164: string } | { error: string } {
  const text = form.phone.value.trim();
  if (!text) return { e164: "" };
  const out = normaliseOwnerPhone(text, form.phoneCountry ?? opts.country ?? "AE");
  return out.ok ? { e164: out.e164 } : { error: out.reason };
}

/**
 * A service needs only a name. Its length is required only where Belline
 * fits it into a day; a length that is given has to be a real one either way.
 * A price is always optional: with none, the agent says the team will confirm
 * it (agent/prompt.ts).
 */
export function lengthProblem(name: string, durationMin: unknown, required: boolean): string | null {
  const minutes = Math.round(Number(durationMin) || 0);
  if (minutes <= 0) {
    return required ? `How long does "${name}" take? Belline books it into your diary, so type the minutes here.` : null;
  }
  if (minutes < 5) return `"${name}" is shorter than 5 minutes. Type the minutes, or leave it empty.`;
  if (minutes > 12 * 60) return "A service can take at most 12 hours (720 minutes).";
  return null;
}

export type SaveCheck =
  | { ok: true; body: SaveBody }
  | {
      ok: false;
      /** Every problem, in screen order. */
      errors: FieldError[];
      /** The first problem's input id: where focus goes. */
      field: string;
      error: string;
    };

/**
 * Everything on the form that stops it being saved, in screen order.
 *
 * There are no confirmation ticks. Pressing save on a screen that shows every
 * value, each read one labelled with where it came from, is the confirmation.
 * A tick beside each block only added a second thing to press, and a way to be
 * stuck on a form without seeing why.
 */
export function reviewErrors(form: ReviewForm, opts: ReviewOptions = {}): FieldError[] {
  const errors: FieldError[] = [];

  const phone = reviewPhone(form, opts);
  if ("error" in phone) errors.push({ id: REVIEW_IDS.phone, message: phone.error });

  const hours = parseHours(form.hours.value);
  if (!hours.ok) errors.push({ id: REVIEW_IDS.hours, message: hours.error });

  form.services.forEach((s, i) => {
    if (!s.name.trim()) return;
    const problem = lengthProblem(s.name.trim(), s.durationMin, opts.lengthsRequired ?? true);
    if (problem) errors.push({ id: REVIEW_IDS.serviceMinutes(i), message: problem });
  });

  form.faqs.forEach((f, i) => {
    const q = Boolean(f.q.trim());
    const a = Boolean(f.a.trim());
    if (q && !a) errors.push({ id: REVIEW_IDS.faqAnswer(i), message: "Type the answer, or remove this question." });
    if (a && !q) errors.push({ id: REVIEW_IDS.faqQuestion(i), message: "Type the question this answers, or remove it." });
  });

  return errors;
}

/** The PUT body for a filled-in form, or every field that stops it being saved. */
export function payloadFromForm(form: ReviewForm, opts: ReviewOptions = {}): SaveCheck {
  const errors = reviewErrors(form, opts);
  const hours = parseHours(form.hours.value);
  if (errors.length || !hours.ok) {
    const all = errors.length ? errors : [{ id: REVIEW_IDS.hours, message: hours.ok ? "" : hours.error }];
    return { ok: false, errors: all, field: all[0].id, error: all[0].message };
  }

  const services = form.services
    .filter((s) => s.name.trim())
    // 0 is "not given", for the length and the price alike.
    .map((s) => ({ name: s.name.trim(), durationMin: Math.max(0, Math.round(Number(s.durationMin) || 0)), price: Math.max(0, Number(s.price) || 0) }));
  const faqs = form.faqs.filter((f) => f.q.trim() && f.a.trim()).map((f) => ({ q: f.q.trim(), a: f.a.trim() }));

  return {
    ok: true,
    body: {
      name: form.name.value.trim(),
      greeting: form.greeting.value.trim(),
      address: form.address.value.trim(),
      // E.164, converted at the field with the country picked beside it.
      phone: (() => {
        const p = reviewPhone(form, opts);
        return "e164" in p ? p.e164 : "";
      })(),
      hours: hours.hours,
      services,
      staff: form.staff.map((s) => s.value.trim()).filter(Boolean),
      faqs,
      policies: form.policies.value.split("\n").map((s) => s.trim()).filter(Boolean),
    },
  };
}

/** A name list as people type it: "Layla, Omar and Sara". */
export function parseStaff(text: string): string[] {
  return text
    .split(/,|\n|\band\b|&/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// The server side of the same body
// ---------------------------------------------------------------------------

export interface Confirmed {
  name?: string;
  address?: string;
  phone?: string;
  greeting?: string;
  hours?: WeeklyHours;
  services?: { name: string; durationMin: number; price: number }[];
  staff?: string[];
  faqs?: Faq[];
  policies?: string[];
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

/**
 * A PUT /api/setup body, checked. Hours may come as the saved shape or as
 * words; anything that does not read is refused with the reason rather than
 * saved half-right.
 */
export type CleanResult =
  | { ok: true; confirmed: Confirmed }
  | {
      ok: false;
      error: string;
      /** The review input the refusal is about, when there is one. */
      field?: string;
      /** The service the refusal is about, by name, so the page can find its row. */
      service?: string;
    };

export function cleanConfirmed(body: Record<string, unknown>, opts: ReviewOptions = {}): CleanResult {
  let hours: WeeklyHours | undefined;
  if (typeof body.hours === "string") {
    const parsed = parseHours(body.hours);
    if (!parsed.ok) return { ok: false, error: parsed.error, field: REVIEW_IDS.hours };
    hours = parsed.hours;
  } else if (body.hours !== undefined && body.hours !== null) {
    const clean = cleanHours(body.hours);
    if (!clean) return { ok: false, error: "Those opening hours could not be read. Check each day.", field: REVIEW_IDS.hours };
    hours = clean;
  }

  const list = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : undefined);

  const services = list(body.services, 80)
    ?.map((s) => ({
      name: str((s as { name?: unknown })?.name, 120) ?? "",
      durationMin: Math.max(0, Math.round(Number((s as { durationMin?: unknown })?.durationMin) || 0)),
      price: Math.max(0, Number((s as { price?: unknown })?.price) || 0),
    }))
    .filter((s) => s.name);
  for (const s of services ?? []) {
    const problem = lengthProblem(s.name, s.durationMin, opts.lengthsRequired ?? true);
    if (problem) return { ok: false, error: problem, service: s.name };
  }

  // The business phone, stored E.164 only: a request without a country code is refused.
  const rawPhone = str(body.phone, 40);
  let phone = rawPhone;
  if (rawPhone) {
    const strict = requireE164(rawPhone);
    if (!strict.ok) return { ok: false, error: strict.reason, field: REVIEW_IDS.phone };
    phone = strict.e164;
  }

  return {
    ok: true,
    confirmed: {
      name: str(body.name, 120) || undefined,
      address: str(body.address, 300),
      phone,
      greeting: str(body.greeting, 400) || undefined,
      hours,
      services,
      staff: list(body.staff, 60)
        ?.map((s) => str(s, 80) ?? "")
        .filter(Boolean),
      faqs: list(body.faqs, 60)
        ?.map((f) => ({ q: str((f as Faq)?.q, 300) ?? "", a: str((f as Faq)?.a, 2000) ?? "" }))
        .filter((f) => f.q && f.a),
      policies: list(body.policies, 40)
        ?.map((p) => str(p, 500) ?? "")
        .filter(Boolean),
    },
  };
}
