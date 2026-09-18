/**
 * When each message goes, and out of which mailbox.
 *
 * Two jobs, both pure, both testable without a clock or a database.
 *
 * **Which mailbox.** Healthiest first, then most remaining capacity. Sorting
 * on health before capacity matters: the mailbox with the most room left is
 * often the one that has been quietly bouncing all morning, and handing it the
 * rest of the day's volume is how one bad address takes a domain with it.
 *
 * **When.** Spread across the working day with a jitter, never in a burst.
 * Thirty messages leaving one address in ninety seconds is the single clearest
 * machine signature a receiving server sees; the same thirty spread over eight
 * hours at irregular intervals is indistinguishable from a person working
 * through a list. The gap is randomised rather than fixed for the same reason
 * — a message exactly every sixteen minutes is also a signature.
 */

import type { SendingMailbox } from "./store";
import type { Health } from "./health";
import { warmupCap } from "./warmup";

export interface SendWindow {
  /** 0 = Sunday, matching Date.getDay() and the rest of the codebase. */
  days: number[];
  /** "09:00" */
  start: string;
  end: string;
  /** IANA zone the window is expressed in. */
  tz: string;
}

export const DEFAULT_WINDOW: SendWindow = {
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:00",
  tz: "Asia/Dubai",
};

export interface MailboxCapacity {
  mailbox: SendingMailbox;
  /** Today's ceiling from the warm-up schedule, or the full cap once warm. */
  capToday: number;
  sentToday: number;
  remaining: number;
  health: Health;
  /** Non-null when this mailbox may not be used at all today, and why. */
  unusable: string | null;
}

export function capacityFor(input: {
  mailbox: SendingMailbox;
  health: Health;
  sentToday: number;
  today: string;
  /** The domain's own state, which overrides an otherwise healthy mailbox. */
  domainPaused?: string | null;
}): MailboxCapacity {
  const capToday = warmupCap(input.mailbox, input.today);
  const remaining = Math.max(0, capToday - input.sentToday);

  let unusable: string | null = null;
  if (input.domainPaused) unusable = `its domain is paused: ${input.domainPaused}`;
  else if (input.mailbox.status === "paused") unusable = input.mailbox.pausedReason ?? "paused";
  else if (input.health.verdict === "stop") unusable = input.health.reasons[0] ?? "health threshold crossed";
  else if (!input.mailbox.warmupStartedOn) unusable = "warm-up has not been started";
  else if (capToday === 0) unusable = "no capacity today";
  else if (remaining === 0) unusable = "today's cap is used up";

  return { mailbox: input.mailbox, capToday, sentToday: input.sentToday, remaining, health: input.health, unusable };
}

const VERDICT_ORDER = { ok: 0, watch: 1, stop: 2 } as const;

/**
 * Mailboxes that may take work now, best first.
 *
 * Deterministic: the same inputs give the same order, so a plan shown on the
 * approval screen is the plan that runs.
 */
export function usableMailboxes(capacities: readonly MailboxCapacity[]): MailboxCapacity[] {
  return capacities
    .filter((c) => c.unusable === null && c.remaining > 0)
    .sort(
      (a, b) =>
        VERDICT_ORDER[a.health.verdict] - VERDICT_ORDER[b.health.verdict] ||
        b.remaining - a.remaining ||
        a.mailbox.id - b.mailbox.id,
    );
}

/**
 * Deal `count` sends round-robin across the usable mailboxes.
 *
 * Round-robin rather than filling one mailbox then the next, because an even
 * spread across identities is the point of having several.
 */
export function allocate(capacities: readonly MailboxCapacity[], count: number): Map<number, number> {
  const usable = usableMailboxes(capacities);
  const out = new Map<number, number>();
  if (usable.length === 0) return out;

  const left = new Map(usable.map((c) => [c.mailbox.id, c.remaining]));
  let placed = 0;
  let progress = true;
  while (placed < count && progress) {
    progress = false;
    for (const capacity of usable) {
      if (placed >= count) break;
      const remaining = left.get(capacity.mailbox.id)!;
      if (remaining <= 0) continue;
      left.set(capacity.mailbox.id, remaining - 1);
      out.set(capacity.mailbox.id, (out.get(capacity.mailbox.id) ?? 0) + 1);
      placed++;
      progress = true;
    }
  }
  return out;
}

/** Total room across every usable mailbox. */
export function totalRoom(capacities: readonly MailboxCapacity[]): number {
  return usableMailboxes(capacities).reduce((sum, c) => sum + c.remaining, 0);
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

/**
 * Where the working day starts and ends today, in epoch milliseconds.
 *
 * The zone is honoured by asking `Intl` what the offset is at that instant
 * rather than doing arithmetic on a fixed offset — Dubai does not observe
 * daylight saving but Zurich does, and this engine now sends to both.
 */
export function windowBounds(window: SendWindow, day: Date): { start: number; end: number } | null {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: window.tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(day);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  if (!window.days.includes(weekday)) return null;

  const localMidnightUtc = Date.parse(`${get("year")}-${get("month")}-${get("day")}T00:00:00Z`);
  // The zone's offset at midday that day, which is the one that applies across
  // a 09:00–17:00 window on either side of a DST change.
  const offsetMs = zoneOffsetMs(window.tz, localMidnightUtc + 12 * 3_600_000);
  const base = localMidnightUtc - offsetMs;
  return { start: base + minutesOf(window.start) * 60_000, end: base + minutesOf(window.end) * 60_000 };
}

function zoneOffsetMs(tz: string, atUtc: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(atUtc));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const asUtc = Date.parse(
    `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`,
  );
  return asUtc - atUtc;
}

/**
 * A small, seeded pseudo-random source.
 *
 * Seeded so a plan can be shown to an approver and then executed unchanged.
 * `Math.random` would make the times on the screen a lie.
 */
export function seededRandom(seed: number): () => number {
  let state = (seed | 0) || 1;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) | 0;
    return ((state >>> 8) & 0xffffff) / 0x1000000;
  };
}

export interface SpreadInput {
  count: number;
  window: SendWindow;
  day: Date;
  /** Nothing is scheduled before this — usually "now". */
  notBefore?: Date;
  seed?: number;
}

/**
 * `count` send times across today's window, ascending, irregularly spaced.
 *
 * Returns fewer than asked (possibly none) when the day is closed or nearly
 * over, which the caller reports rather than papering over: sending outside
 * the window because the plan was made late is exactly the behaviour that
 * gets a domain filtered.
 */
export function spreadOverDay(input: SpreadInput): Date[] {
  const bounds = windowBounds(input.window, input.day);
  if (!bounds) return [];

  const floor = Math.max(bounds.start, input.notBefore?.getTime() ?? 0);
  const span = bounds.end - floor;
  if (input.count <= 0 || span <= 0) return [];

  const random = seededRandom(input.seed ?? input.count * 7919 + Math.floor(floor / 60_000));
  const slot = span / input.count;
  const out: Date[] = [];
  for (let i = 0; i < input.count; i++) {
    // Somewhere in this message's own slot, so two never collide and the gaps
    // are uneven without ever going backwards.
    const jitter = random() * slot * 0.8 + slot * 0.1;
    out.push(new Date(Math.round(floor + i * slot + jitter)));
  }
  return out;
}

export interface PlannedSend {
  mailboxId: number;
  address: string;
  at: Date;
}

/**
 * The finished timetable: who sends what, when.
 *
 * Each mailbox gets its own spread across the day rather than one global
 * sequence chopped up, so each address's own pattern looks like a person
 * working — which is the thing a receiving server scores.
 */
export function planDay(input: {
  capacities: readonly MailboxCapacity[];
  count: number;
  window: SendWindow;
  day: Date;
  notBefore?: Date;
  seed?: number;
}): { sends: PlannedSend[]; unplaced: number; reason?: string } {
  const allocation = allocate(input.capacities, input.count);
  const sends: PlannedSend[] = [];
  let placed = 0;

  for (const [mailboxId, share] of allocation) {
    const capacity = input.capacities.find((c) => c.mailbox.id === mailboxId)!;
    const times = spreadOverDay({
      count: share,
      window: input.window,
      day: input.day,
      notBefore: input.notBefore,
      seed: (input.seed ?? 1) * 31 + mailboxId,
    });
    for (const at of times) {
      sends.push({ mailboxId, address: capacity.mailbox.address, at });
      placed++;
    }
  }

  sends.sort((a, b) => a.at.getTime() - b.at.getTime());
  const unplaced = input.count - placed;
  let reason: string | undefined;
  if (unplaced > 0) {
    if (allocation.size === 0) reason = "no mailbox has capacity today";
    else if (!windowBounds(input.window, input.day)) reason = "today is outside the sending window";
    else reason = "not enough of the working day is left";
  }
  return { sends, unplaced, reason };
}
