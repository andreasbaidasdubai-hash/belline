import type { Location, User } from "../types";
import { getLocation, listCalls, listUsersFor } from "../store";
import { todayIn } from "../time";
import { accountFor } from "../billing/usage";
import { channelStatuses, factsFrom, journey } from "../onboarding/journey";
import { openException, ownerTickets } from "../exceptions";
import { BELLINE_LOCATION_ID, bellineVenue as bellineSeed } from "../seed-belline";
import { BELLE_DISCLOSURE, PAGE_GUIDE, belleKnowledge, pageLink } from "./knowledge";

/**
 * Belle in the dashboard: support mode.
 *
 * Besides saving a business's information (onboarding/assistant.ts), she
 * answers questions about Belline from the knowledge base and about the
 * owner's own account from the facts below — which are read from one
 * location, and only when it belongs to the tenant of the person asking. A
 * location from another tenant yields nothing at all, not an error message
 * with its name in it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from today to an ISO date, in the venue's timezone. */
function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

/**
 * The owner's own account, as plain lines for the model: plan, trial, usage,
 * channels, setup, tickets and team size. Empty when the location is not the
 * viewer's tenant's.
 */
export function accountFacts(location: Location | undefined, viewerTenantId: string, now: Date = new Date()): string {
  if (!location || location.tenantId !== viewerTenantId || location.internal) return "";
  const today = todayIn(location.timezone);
  const calls = listCalls(location.id);
  const facts = factsFrom(location, calls);
  const j = journey(location, facts, now);
  const sub = location.subscription;
  const account = accountFor(location, today);

  const lines: string[] = [`Business: ${location.name}.`];
  if (!sub || !account) {
    lines.push("Plan: none on record yet.");
  } else if (sub.status === "trialing") {
    const ends = sub.trial?.endsOn;
    lines.push(
      ends
        ? `Plan: free trial, ${Math.max(0, daysUntil(ends, today))} days left (ends ${ends}).`
        : "Plan: free trial. The 30 days start counting when the business goes live, so none are used yet.",
    );
  } else {
    lines.push(`Plan: ${account.name}, ${sub.cycle}, ${sub.status}${sub.paymentFailedAt ? ", last payment failed" : ""}.`);
  }
  if (account) {
    const period = account.usage.period;
    lines.push(
      `Usage this period (${period.start} to ${period.end}): ${
        account.usage.meters
          .map((m) => `${m.name} ${m.used}${m.included === null ? "" : ` of ${m.included}`}`)
          .join("; ") || "nothing counted"
      }.`,
    );
  }
  lines.push(`Channels: ${channelStatuses(location, facts, { now }).map((c) => `${c.label} ${c.state.replace(/_/g, " ")} (${c.detail})`).join("; ")}.`);
  lines.push(
    j.next
      ? `Setup: on step ${j.next.n} of ${j.steps.length}, ${j.next.title} (${j.next.url}).${j.blockers.length ? ` Before going live: ${j.blockers.slice(0, 4).map((b) => b.label).join("; ")}.` : ""}`
      : "Setup: finished, the business is live.",
  );
  const tickets = ownerTickets(location.id);
  if (tickets.length) lines.push(`Tickets with the Belline team: ${tickets.map((t) => `${t.ticket} (${t.status})`).join(", ")}.`);
  lines.push(`Dashboard users: ${listUsersFor(location.tenantId).filter((u) => !u.disabled).length}.`);
  return lines.join("\n");
}

/** Where the owner is in the dashboard, as a fixed sentence from the page guide. Unknown paths say nothing. */
export function dashboardPageNote(path: unknown): string {
  if (typeof path !== "string") return "";
  const clean = path.split(/[?#]/)[0];
  if (/^\/setup\/[a-z-]+$/.test(clean) && pageLink(clean)) return `The owner has Ask Belle open on the setup step ${clean}.`;
  const guide = PAGE_GUIDE[clean];
  return guide ? `The owner has Ask Belle open on ${clean} (${guide.split(":")[0]}).` : "";
}

/** The support block for the dashboard's Ask Belle: who she is, what she covers, the knowledge base and the account. */
export function supportSystem(location: Location, viewerTenantId: string, opts: { page?: string; now?: Date } = {}): string {
  const faqs = (getLocation(BELLINE_LOCATION_ID) ?? bellineSeed).agent.faqs;
  const facts = accountFacts(location, viewerTenantId, opts.now);
  const page = dashboardPageNote(opts.page);
  return [
    `You are ${BELLE_DISCLOSURE}, in the owner's Belline dashboard. If asked, say plainly you are an AI.`,
    "Besides setting the business up, you answer anything about Belline from the knowledge base, anything about this owner's own account from the account data, and how to do things in the dashboard. When a page would help, call link_to_page so they get a button to it.",
    "You cannot change plans, billing, cancel anything or delete anything, and you never say you have. Send them to the page for it. For a billing question, a failed payment or anything only the Belline team can do, tell them to press Talk to a person.",
    "Answer only from the knowledge base and the account data. If it is not there, say you don't know and offer Talk to a person. Never invent a price, a date or a feature, and never mention another business's account.",
    page,
    facts ? `# This owner's account (their data only)\n${facts}` : "",
    belleKnowledge({ mode: "support", faqs }),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The briefing for an owner's video call with Belle: Belline's own video
 * persona (sales prompt and knowledge base), told this is a customer asking
 * for help with their account, not a prospect.
 */
export function supportVideoBriefing(location: Location, viewer: Pick<User, "tenantId" | "name">): string {
  const facts = accountFacts(location, viewer.tenantId);
  return [
    `Support call: ${viewer.name || "the owner"} of ${location.name} is already a Belline customer, signed in to their dashboard. Do not sell: no demo, no trial, no checkout, no lead. Help with their account and how to use Belline, from the knowledge base and the account data below. You cannot change their plan or billing; send them to Settings > Billing and usage, or to Talk to a person in Ask Belle.`,
    facts ? `Account data (theirs only):\n${facts}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const SUPPORT_VIDEO_GREETING = "Hi, I'm Belle, Belline's AI assistant. I can see your account — what can I help you with?";

/**
 * "Talk to a person": a ticket for the Belline team, with what the owner was
 * looking at and the last few lines of the conversation. Pressing the button
 * is the request, so there is no "ask twice" here (that rule is for typing).
 */
export function openSupportHandover(input: {
  user: Pick<User, "id" | "tenantId" | "email" | "name">;
  location: Location;
  page?: string;
  history?: { role: "user" | "assistant"; content: string }[];
}): { ticket: string; reply: string } | null {
  const { user, location } = input;
  if (location.tenantId !== user.tenantId) return null;
  const excerpt = (input.history ?? [])
    .slice(-8)
    .map((m) => `${m.role === "user" ? "Owner" : "Belle"}: ${m.content.slice(0, 240)}`)
    .join("\n");
  const page = typeof input.page === "string" && (PAGE_GUIDE[input.page.split(/[?#]/)[0]] || pageLink(input.page)) ? input.page.split(/[?#]/)[0] : undefined;
  const opened = openException({
    tenantId: location.tenantId,
    locationId: location.id,
    kind: "owner_requested_human",
    reason: "Pressed Talk to a person in Ask Belle.",
    context: { userId: user.id, via: "ask_belle", ...(page ? { page } : {}), ...(excerpt ? { excerpt } : {}) },
    source: "belle",
  });
  const ticket = opened.exception.ticket;
  return {
    ticket,
    reply: `I've passed this to the Belline team. Your ticket is ${ticket}. They'll reply by email to ${user.email}, so there's nothing else you need to do for this.`,
  };
}
