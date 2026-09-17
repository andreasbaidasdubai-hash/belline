import { listLocations, listTenants } from "../store";
import { listAbuse } from "../abuse/review";
import { listExceptions, KIND_META } from "../exceptions";
import { clientBook, totalsOf } from "../sales/clients";
import { phoneCostPerMinuteFils } from "../billing/cost";
import { todayIn, addDays } from "../time";
import { allLeads, humanDay, leadHref, SOURCE_LABEL, type LeadDbPort, realDbPort } from "./leads";
import { draftsAwaitingReview } from "./drafts";

/**
 * What needs a person today, and four numbers.
 *
 * Each list is short and each item links to the page where it gets done. The
 * order is the order of urgency: people who asked us something, leads that
 * just showed interest, customers who are stuck, signups that look wrong,
 * drafts waiting for a decision, trials about to end.
 */

export interface AttentionItem {
  key: string;
  title: string;
  detail: string;
  href: string;
  at?: string;
}

export interface AttentionGroup {
  id: "new_leads" | "hot_leads" | "issues" | "flagged" | "drafts" | "trials";
  title: string;
  /** Where the whole list lives. */
  href: string;
  total: number;
  items: AttentionItem[];
  empty: string;
}

const SHOW = 6;

export async function todayAttention(port: LeadDbPort = realDbPort, now = new Date()): Promise<{ groups: AttentionGroup[]; pipelineRead: boolean }> {
  const { leads, pipelineRead } = await allLeads(port, now.getTime());

  const fresh = leads
    .filter((l) => l.stage === "new" && l.source !== "researched")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const hot = leads.filter((l) => l.hot && !["customer", "lost", "do_not_contact"].includes(l.stage));
  const issues = listExceptions({ status: "unresolved" });
  const flagged = listAbuse({ status: "open" });
  const drafts = await draftsAwaitingReview(50);
  const tenants = new Map(listTenants().map((t) => [t.id, t]));
  const endingBy = (tz: string) => addDays(todayIn(tz), 7);
  const trials = listLocations()
    .filter((l) => !tenants.get(l.tenantId)?.internal && l.subscription?.status === "trialing" && l.subscription.trial?.endsOn)
    .filter((l) => l.subscription!.trial!.endsOn! <= endingBy(l.timezone))
    .sort((a, b) => a.subscription!.trial!.endsOn!.localeCompare(b.subscription!.trial!.endsOn!));

  const groups: AttentionGroup[] = [
    {
      id: "new_leads",
      title: "New enquiries and leads to contact",
      href: "/sales/leads?stage=new",
      total: fresh.length,
      items: fresh.slice(0, SHOW).map((l) => ({
        key: l.id,
        title: l.name,
        detail: [SOURCE_LABEL[l.source], l.contactName, l.countryName].filter(Boolean).join(" · "),
        href: leadHref(l.id),
        at: l.createdAt,
      })),
      empty: "Nobody new is waiting to hear from us.",
    },
    {
      id: "hot_leads",
      title: "Hot leads",
      href: "/sales/leads?hot=1",
      total: hot.length,
      items: hot.slice(0, SHOW).map((l) => ({
        key: l.id,
        title: l.name,
        detail: [l.score !== null ? `Score ${l.score}` : null, l.stage === "demo_watched" ? "Watched the demo" : null, SOURCE_LABEL[l.source]].filter(Boolean).join(" · "),
        href: leadHref(l.id),
        at: l.lastActivityAt,
      })),
      empty: "No hot leads right now. A lead turns hot when it scores high or watches its demo.",
    },
    {
      id: "issues",
      title: "Customers who need help",
      href: "/sales/issues",
      total: issues.length,
      items: issues.slice(0, SHOW).map((r) => ({
        key: r.id,
        title: `${tenants.get(r.tenantId)?.name ?? "Unknown customer"}: ${KIND_META[r.kind].label}`,
        detail: r.reason,
        href: `/sales/issues?ticket=${encodeURIComponent(r.ticket)}`,
        at: r.lastRaisedAt,
      })),
      empty: "No customer is stuck.",
    },
    {
      id: "flagged",
      title: "Flagged signups",
      href: "/sales/customers?view=flagged",
      total: flagged.length,
      items: flagged.slice(0, SHOW).map((r) => ({
        key: r.id,
        title: (r.tenantId && tenants.get(r.tenantId)?.name) || r.email || "A signup",
        detail: FLAG_LABEL[r.kind],
        href: r.tenantId ? `/sales/customers/${encodeURIComponent(r.tenantId)}#flags` : "/sales/customers?view=flagged",
        at: r.lastAt,
      })),
      empty: "No signup looks like a second free trial.",
    },
    {
      id: "drafts",
      title: "Drafts to review",
      href: "/sales/leads?view=drafts",
      total: drafts.length,
      items: drafts.slice(0, SHOW).map((d) => ({
        key: String(d.messageId),
        title: d.company,
        detail: d.held ? `Held back by the checks · ${d.subject}` : d.subject,
        href: `${leadHref(`db:${d.leadId}`)}#email-draft`,
        at: d.createdAt,
      })),
      empty: pipelineRead ? "No drafts are waiting." : "Drafts appear here once the sales database is connected.",
    },
    {
      id: "trials",
      title: "Trials ending in the next 7 days",
      href: "/sales/customers?status=trial",
      total: trials.length,
      items: trials.slice(0, SHOW).map((l) => ({
        key: l.id,
        title: tenants.get(l.tenantId)?.name ?? l.name,
        detail: `${l.name} · ends ${humanDay(l.subscription!.trial!.endsOn!)}`,
        href: `/sales/customers/${encodeURIComponent(l.tenantId)}`,
      })),
      empty: "No trial ends this week.",
    },
  ];
  return { groups, pipelineRead };
}

export const FLAG_LABEL: Record<string, string> = {
  duplicate_business: "Business already has an account",
  disposable_email: "Throwaway email address",
  ip_limit: "Too many trials from one network",
  device_limit: "Too many trials from one browser",
  many_signups_ip: "Several signups from one network today",
};

export interface TodayKpis {
  mrrFils: number;
  activeCustomers: number;
  trials: number;
  signups7d: number;
}

export function todayKpis(now = new Date()): TodayKpis {
  const rows = clientBook(now);
  const totals = totalsOf(rows, now, phoneCostPerMinuteFils());
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const customers = listTenants().filter((t) => !t.internal);
  return {
    mrrFils: totals.mrrFils,
    activeCustomers: new Set(rows.filter((r) => r.status === "active").map((r) => r.tenantId)).size,
    trials: new Set(rows.filter((r) => r.status === "trialing").map((r) => r.tenantId)).size,
    signups7d: customers.filter((t) => (t.signup?.at ?? t.createdAt) >= since).length,
  };
}
