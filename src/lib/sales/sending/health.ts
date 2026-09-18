/**
 * Mailbox and domain health.
 *
 * Two numbers decide whether an identity keeps sending: the share of messages
 * that bounced and the share that drew a complaint. Amazon suspends an account
 * over 5% bounces or 0.1% complaints, and by the time you are near either the
 * damage to the domain is already done — so the engine stops a mailbox well
 * before Amazon would, at 3% and 0.08%.
 *
 * Rates are meaningless on small numbers: one bounce out of four is 25% and
 * says nothing. So a threshold only bites once there is a floor of sends
 * behind it, and below that floor an absolute count of hard bounces is what
 * trips the switch instead.
 */

import type { SendEvent, SendingDomain, SendingMailbox } from "./store";

export interface HealthCounts {
  sent: number;
  delivered: number;
  bounces: number;
  complaints: number;
  replies: number;
  unsubscribes: number;
  demoViews: number;
}

export interface Health extends HealthCounts {
  bounceRate: number;
  complaintRate: number;
  replyRate: number;
  /** "ok" | "watch" | "stop" — `stop` is what pauses a mailbox. */
  verdict: "ok" | "watch" | "stop";
  reasons: string[];
}

export const BOUNCE_STOP = 0.03;
export const BOUNCE_WATCH = 0.02;
export const COMPLAINT_STOP = 0.0008;
export const COMPLAINT_WATCH = 0.0004;
/** Below this many sends a rate is noise, so absolute counts decide. */
export const RATE_FLOOR = 50;
/** Hard bounces on a young mailbox that mean stop regardless of the rate. */
export const YOUNG_BOUNCE_STOP = 5;
export const YOUNG_COMPLAINT_STOP = 1;

export function emptyCounts(): HealthCounts {
  return { sent: 0, delivered: 0, bounces: 0, complaints: 0, replies: 0, unsubscribes: 0, demoViews: 0 };
}

export function countEvents(events: readonly SendEvent[]): HealthCounts {
  const counts = emptyCounts();
  for (const event of events) {
    switch (event.kind) {
      case "sent": counts.sent++; break;
      case "delivered": counts.delivered++; break;
      case "bounce": counts.bounces++; break;
      case "complaint": counts.complaints++; break;
      case "reply": counts.replies++; break;
      case "unsubscribe": counts.unsubscribes++; break;
      case "demo_view": counts.demoViews++; break;
      default: break;
    }
  }
  return counts;
}

export function assess(counts: HealthCounts): Health {
  const denominator = Math.max(counts.sent, 1);
  const bounceRate = counts.bounces / denominator;
  const complaintRate = counts.complaints / denominator;
  const replyRate = counts.replies / denominator;
  const reasons: string[] = [];
  let verdict: Health["verdict"] = "ok";

  const worse = (v: Health["verdict"]) => {
    if (v === "stop") verdict = "stop";
    else if (v === "watch" && verdict === "ok") verdict = "watch";
  };

  if (counts.sent >= RATE_FLOOR) {
    if (bounceRate >= BOUNCE_STOP) {
      reasons.push(`${pct(bounceRate)} of messages bounced (stop at ${pct(BOUNCE_STOP)})`);
      worse("stop");
    } else if (bounceRate >= BOUNCE_WATCH) {
      reasons.push(`${pct(bounceRate)} of messages bounced`);
      worse("watch");
    }
    if (complaintRate >= COMPLAINT_STOP) {
      reasons.push(`${pct(complaintRate)} complained (stop at ${pct(COMPLAINT_STOP)})`);
      worse("stop");
    } else if (complaintRate >= COMPLAINT_WATCH) {
      reasons.push(`${pct(complaintRate)} complained`);
      worse("watch");
    }
  } else {
    // Too few sends for a rate to mean anything. Counts instead.
    if (counts.bounces >= YOUNG_BOUNCE_STOP) {
      reasons.push(`${counts.bounces} bounces in the first ${counts.sent} sends`);
      worse("stop");
    } else if (counts.bounces >= 2) {
      reasons.push(`${counts.bounces} bounces in the first ${counts.sent} sends`);
      worse("watch");
    }
    if (counts.complaints >= YOUNG_COMPLAINT_STOP) {
      reasons.push(`a complaint in the first ${counts.sent} sends`);
      worse("stop");
    }
  }

  return { ...counts, bounceRate, complaintRate, replyRate, verdict, reasons };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
}

export interface MailboxHealth extends Health {
  mailbox: SendingMailbox;
}

export interface DomainHealth extends Health {
  domain: SendingDomain;
  mailboxes: MailboxHealth[];
}

export function healthByMailbox(
  mailboxes: readonly SendingMailbox[],
  events: readonly SendEvent[],
): MailboxHealth[] {
  return mailboxes.map((mailbox) => ({
    mailbox,
    ...assess(countEvents(events.filter((e) => e.mailboxId === mailbox.id))),
  }));
}

export function healthByDomain(
  domains: readonly SendingDomain[],
  mailboxes: readonly SendingMailbox[],
  events: readonly SendEvent[],
): DomainHealth[] {
  return domains.map((domain) => {
    const own = mailboxes.filter((m) => m.domainId === domain.id);
    return {
      domain,
      mailboxes: healthByMailbox(own, events),
      ...assess(countEvents(events.filter((e) => e.domainId === domain.id))),
    };
  });
}
