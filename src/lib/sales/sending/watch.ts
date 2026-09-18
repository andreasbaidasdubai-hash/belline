/**
 * The watchdog.
 *
 * Health thresholds are only worth having if something acts on them without
 * being asked. This runs after every dispatch pass: it re-reads the last
 * thirty days of events, pauses any mailbox whose numbers have crossed the
 * stop line, and raises a ticket on the Issues page so a person finds out the
 * same day rather than when the domain stops delivering.
 *
 * Pausing is one-way here. Nothing in this file un-pauses anything — a
 * mailbox that stopped itself is resumed by a person who has looked at what it
 * was sending, which is the entire point of stopping it.
 */

import { openException } from "../../exceptions";
import { healthByDomain, type DomainHealth } from "./health";
import { sendingStore, type SendingStore } from "./store";

/**
 * The tenant these tickets belong to.
 *
 * Belline's own internal tenant: this is our sending reputation, not a
 * customer's. `openException` de-duplicates per tenant and kind, so one
 * unhealthy domain produces one ticket that counts up rather than a new row
 * every time the watchdog runs.
 */
const INTERNAL_TENANT = "belline";

export interface WatchResult {
  domains: DomainHealth[];
  paused: { mailbox: string; reason: string }[];
  tickets: { ticket: string; kind: string; reason: string }[];
}

export async function watchHealth(input: { store?: SendingStore; now?: Date } = {}): Promise<WatchResult> {
  const store = input.store ?? sendingStore();
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();

  const [domains, mailboxes, events] = await Promise.all([
    store.listDomains(),
    store.listMailboxes(),
    store.listEvents({ since, limit: 10_000 }),
  ]);

  const health = healthByDomain(domains, mailboxes, events);
  const result: WatchResult = { domains: health, paused: [], tickets: [] };

  for (const domain of health) {
    for (const entry of domain.mailboxes) {
      if (entry.verdict !== "stop" || entry.mailbox.status === "paused") continue;
      const reason = entry.reasons[0] ?? "health threshold crossed";
      await store.updateMailbox(entry.mailbox.id, {
        status: "paused",
        pausedReason: reason,
        pausedAt: now.toISOString(),
      });
      result.paused.push({ mailbox: entry.mailbox.address, reason });
      const opened = openException({
        tenantId: INTERNAL_TENANT,
        locationId: entry.mailbox.address,
        kind: "sending_mailbox_paused",
        reason: `${entry.mailbox.address} stopped itself: ${reason}`,
        context: {
          domain: domain.domain.domain,
          sent: entry.sent,
          bounces: entry.bounces,
          complaints: entry.complaints,
        },
        source: "system",
      });
      result.tickets.push({
        ticket: opened.exception.ticket,
        kind: "sending_mailbox_paused",
        reason,
      });
    }

    if (domain.verdict === "stop" && domain.domain.status !== "paused") {
      const reason = domain.reasons[0] ?? "health threshold crossed";
      await store.updateDomain(domain.domain.id, {
        status: "paused",
        pausedReason: reason,
        pausedAt: now.toISOString(),
      });
      const opened = openException({
        tenantId: INTERNAL_TENANT,
        locationId: domain.domain.domain,
        kind: "sending_domain_unhealthy",
        reason: `${domain.domain.domain}: ${reason}`,
        context: {
          sent: domain.sent,
          bounces: domain.bounces,
          complaints: domain.complaints,
          mailboxes: domain.mailboxes.length,
        },
        source: "system",
      });
      result.tickets.push({ ticket: opened.exception.ticket, kind: "sending_domain_unhealthy", reason });
    }
  }

  return result;
}

export interface Observability {
  since: string;
  perDomain: {
    domain: string;
    status: string;
    sent: number;
    bounces: number;
    complaints: number;
    replies: number;
    unsubscribes: number;
    demoViews: number;
    bounceRate: number;
    complaintRate: number;
    verdict: "ok" | "watch" | "stop";
    reasons: string[];
  }[];
  perMailbox: {
    address: string;
    domain: string;
    status: string;
    sent: number;
    bounces: number;
    complaints: number;
    replies: number;
    verdict: "ok" | "watch" | "stop";
    reasons: string[];
  }[];
  totals: { sent: number; bounces: number; complaints: number; replies: number; demoViews: number };
}

/** The numbers the observability screen shows. Read-only; changes nothing. */
export async function observe(input: { store?: SendingStore; days?: number; now?: Date } = {}): Promise<Observability> {
  const store = input.store ?? sendingStore();
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - (input.days ?? 30) * 86_400_000).toISOString();
  const [domains, mailboxes, events] = await Promise.all([
    store.listDomains(),
    store.listMailboxes(),
    store.listEvents({ since, limit: 10_000 }),
  ]);
  const health = healthByDomain(domains, mailboxes, events);

  const perMailbox = health.flatMap((d) =>
    d.mailboxes.map((m) => ({
      address: m.mailbox.address,
      domain: d.domain.domain,
      status: m.mailbox.status,
      sent: m.sent,
      bounces: m.bounces,
      complaints: m.complaints,
      replies: m.replies,
      verdict: m.verdict,
      reasons: m.reasons,
    })),
  );

  const totals = health.reduce(
    (acc, d) => ({
      sent: acc.sent + d.sent,
      bounces: acc.bounces + d.bounces,
      complaints: acc.complaints + d.complaints,
      replies: acc.replies + d.replies,
      demoViews: acc.demoViews + d.demoViews,
    }),
    { sent: 0, bounces: 0, complaints: 0, replies: 0, demoViews: 0 },
  );

  return {
    since,
    perDomain: health.map((d) => ({
      domain: d.domain.domain,
      status: d.domain.status,
      sent: d.sent,
      bounces: d.bounces,
      complaints: d.complaints,
      replies: d.replies,
      unsubscribes: d.unsubscribes,
      demoViews: d.demoViews,
      bounceRate: d.bounceRate,
      complaintRate: d.complaintRate,
      verdict: d.verdict,
      reasons: d.reasons,
    })),
    perMailbox,
    totals,
  };
}
