import type { Location, Tenant, User } from "../types";
import {
  deleteSessions,
  getLocation,
  getTenant,
  getUser,
  listAbuseRows,
  listBusinesses,
  listCosts,
  listLocationsFor,
  listTenants,
  listUsersFor,
  saveBusiness,
  saveTenant,
  saveUser,
  upsertLocation,
} from "../store";
import { isBellineStaff, signResetToken, RESET_LINK_MINUTES } from "../auth";
import { appOrigin } from "../origin";
import { accountFor, productsOf, subscriptionMarket } from "../billing/usage";
import { isProductId, productById, sellable, selectionName, type ProductId } from "../billing/plans";
import { stripeEnabled } from "../billing/stripe";
import { FILS_PER_USD } from "../billing/cost";
import { MARKETS } from "../markets";
import { addDays, todayIn } from "../time";
import { listExceptions } from "../exceptions";
import { markEmailVerified, needsEmailVerification } from "../email-verify";
import { clientBook } from "../sales/clients";
import { cleanReason, reasonProblem, staffAudit } from "./audit";

/**
 * Customers, one row per business.
 *
 * The client book (sales/clients.ts) is a row per location because that is
 * what is billed. Staff think in businesses: who signed up, who to ring, what
 * the whole account pays. So this rolls the book up per tenant and adds the
 * people, the flags and the issues, and it carries every action a person at
 * Belline takes on an account, each authorised by the caller and audited here.
 *
 * Belline's own tenants are never listed and never acted on.
 *
 * No `next/*` imports: the checks drive the actions directly.
 */

export type CustomerStatus = "trial" | "active" | "suspended" | "cancelled" | "setting_up";

export const CUSTOMER_STATUS_LABEL: Record<CustomerStatus, string> = {
  trial: "Trial",
  active: "Active",
  suspended: "Suspended",
  cancelled: "Cancelled",
  setting_up: "Setting up",
};

export interface CustomerRow {
  tenantId: string;
  name: string;
  locations: number;
  owner: { id: string; name: string; email: string } | null;
  plan: string;
  status: CustomerStatus;
  paymentFailed: boolean;
  trialEndsOn: string | null;
  /** Highest share of any allowance used this period, 0–100. Null with nothing counted. */
  usagePct: number | null;
  mrrFils: number;
  country: string | null;
  signedUpAt: string;
  flagged: number;
  openIssues: number;
}

export function customerTenants(): Tenant[] {
  return listTenants().filter((t) => !t.internal);
}

/** A customer's tenant, or undefined for Belline's own and for ids that do not exist. */
export function customerTenant(tenantId: string): Tenant | undefined {
  const tenant = getTenant(tenantId);
  return tenant && !tenant.internal ? tenant : undefined;
}

function statusOf(tenant: Tenant, locations: Location[]): CustomerStatus {
  const subs = locations.map((l) => l.subscription).filter((s) => s !== undefined);
  if (tenant.abuse?.trialSuspendedAt && subs.some((s) => s.status === "trialing")) return "suspended";
  if (subs.some((s) => s.status === "active")) return "active";
  if (subs.some((s) => s.status === "trialing")) return "trial";
  if (subs.some((s) => s.status === "cancelled")) return "cancelled";
  return "setting_up";
}

export function customerRows(now = new Date()): CustomerRow[] {
  const book = clientBook(now);
  const abuse = listAbuseRows().filter((r) => r.status === "open" || r.status === "noted");
  const issues = listExceptions({ status: "unresolved" });
  return customerTenants()
    .map((tenant): CustomerRow => {
      const locations = listLocationsFor(tenant.id).filter((l) => !l.demo?.enabled && !l.prospect);
      const rows = book.filter((r) => r.tenantId === tenant.id);
      const owner = listUsersFor(tenant.id).find((u) => u.role === "owner") ?? null;
      const trialEnds = rows.map((r) => r.trialEndsOn).filter((d): d is string => Boolean(d)).sort();
      let usage: number | null = null;
      for (const l of locations) {
        const account = accountFor(l, todayIn(l.timezone));
        for (const m of account?.usage.meters ?? []) {
          if (m.included) usage = Math.max(usage ?? 0, Math.round(m.fraction * 100));
        }
      }
      const market = locations[0]?.subscription ? subscriptionMarket(locations[0].subscription) : null;
      return {
        tenantId: tenant.id,
        name: tenant.name,
        locations: locations.length,
        owner: owner ? { id: owner.id, name: owner.name, email: owner.email } : null,
        plan: [...new Set(rows.map((r) => r.planName).filter((p) => p !== "—"))].join(", ") || "None yet",
        status: statusOf(tenant, locations),
        paymentFailed: rows.some((r) => r.paymentFailedAt),
        trialEndsOn: trialEnds[0] ?? null,
        usagePct: usage,
        mrrFils: rows.reduce((n, r) => n + r.mrrFils, 0),
        country: market ? MARKETS[market].name : null,
        signedUpAt: tenant.signup?.at ?? tenant.createdAt,
        flagged: abuse.filter((r) => r.tenantId === tenant.id).length,
        openIssues: issues.filter((r) => r.tenantId === tenant.id).length,
      };
    })
    .sort((a, b) => b.signedUpAt.localeCompare(a.signedUpAt));
}

export interface CustomerFilter {
  status?: CustomerStatus;
  flagged?: boolean;
  q?: string;
}

export function filterCustomers(rows: CustomerRow[], f: CustomerFilter): CustomerRow[] {
  const q = f.q?.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.status && r.status !== f.status) return false;
    if (f.flagged && r.flagged === 0) return false;
    if (q && ![r.name, r.owner?.name, r.owner?.email, r.country].some((v) => v?.toLowerCase().includes(q))) return false;
    return true;
  });
}

// --- one customer --------------------------------------------------------------

export interface MeterView {
  name: string;
  used: number;
  included: number | null;
  pct: number | null;
  unit: string;
}

export interface LocationUsage {
  locationId: string;
  period: { start: string; end: string } | null;
  meters: MeterView[];
  costFils: number;
}

export function usageFor(location: Location): LocationUsage {
  const account = accountFor(location, todayIn(location.timezone));
  const since = account ? `${account.usage.period.start}T00:00:00.000Z` : undefined;
  const usd = listCosts({ venueId: location.id, since }).reduce((n, e) => n + e.usd, 0);
  return {
    locationId: location.id,
    period: account ? { start: account.usage.period.start, end: account.usage.period.end } : null,
    meters: (account?.usage.meters ?? []).map((m) => ({
      name: m.name,
      used: Math.round(m.used * 10) / 10,
      included: m.included,
      pct: m.included ? Math.round(m.fraction * 100) : null,
      unit: m.unit === "minutes" ? "min" : "conversations",
    })),
    costFils: Math.round(usd * FILS_PER_USD),
  };
}

export function sellablePlans(location: Location): { id: ProductId; name: string }[] {
  return sellable(subscriptionMarket(location.subscription)).map((p) => ({ id: p.id, name: p.name }));
}

export function planNameOf(location: Location): string {
  const sub = location.subscription;
  if (!sub) return "None yet";
  const products = productsOf(sub);
  return products.length ? selectionName(products) : "None";
}

export function paymentsOpen(): boolean {
  return stripeEnabled();
}

// --- actions -------------------------------------------------------------------

export type Result<T = undefined> = { ok: true; value: T } | { ok: false; status: number; error: string };

const refuse = (status: number, error: string): Result<never> => ({ ok: false, status, error });

/** Staff only, and never on Belline's own tenants. Every action starts here. */
function authorise(actor: User, tenantId: string): Result<Tenant> {
  if (!isBellineStaff(actor)) return refuse(403, "Belline staff only.");
  const tenant = customerTenant(tenantId);
  if (!tenant) return refuse(404, "No such customer.");
  return { ok: true, value: tenant };
}

function locationOf(tenant: Tenant, locationId: unknown): Location | undefined {
  const location = typeof locationId === "string" ? getLocation(locationId) : undefined;
  return location && location.tenantId === tenant.id ? location : undefined;
}

export async function updateBusinessDetails(
  actor: User,
  tenantId: string,
  input: { name?: unknown; category?: unknown; email?: unknown; phone?: unknown },
): Promise<Result> {
  const auth = authorise(actor, tenantId);
  if (!auth.ok) return auth;
  const tenant = auth.value;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = text(input.name, 120);
  const category = text(input.category, 60);
  const email = text(input.email, 254).toLowerCase();
  const phone = text(input.phone, 32);
  if (name.length < 2) return refuse(422, "The business needs a name.");
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return refuse(422, "That does not look like an email address.");
  if (phone && !/^\+?[\d\s()-]{6,}$/.test(phone)) return refuse(422, "That does not look like a phone number.");

  const business = listBusinesses(tenant.id)[0];
  const before = { name: tenant.name, category: business?.category ?? null, email: business?.email ?? null, phone: business?.phone ?? null };
  const after = { name, category: category || null, email: email || null, phone: phone || null };
  if (JSON.stringify(before) === JSON.stringify(after)) return { ok: true, value: undefined };
  saveTenant({ ...tenant, name });
  if (business) {
    saveBusiness({ ...business, name, category: category || undefined, email: email || undefined, phone: phone || undefined });
  }
  await staffAudit({ actor, action: "customer_details_changed", entity: "tenant", entityId: tenant.id, before, after });
  return { ok: true, value: undefined };
}

export async function extendTrial(actor: User, tenantId: string, locationId: unknown, days: unknown, reason: unknown, now = new Date()): Promise<Result<{ to: string }>> {
  const auth = authorise(actor, tenantId);
  if (!auth.ok) return auth;
  const location = locationOf(auth.value, locationId);
  if (!location) return refuse(404, "No such location for this customer.");
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 90) return refuse(422, "Extend by a whole number of days, from 1 to 90.");
  const problem = reasonProblem(reason);
  if (problem) return refuse(422, problem);
  const sub = location.subscription;
  if (!sub || sub.status !== "trialing" || !sub.trial) return refuse(409, "This location is not on a free trial.");
  if (!sub.trial.endsOn) return refuse(409, "The free month starts when the location goes live, so there is no end date to extend yet.");
  const from = sub.trial.endsOn;
  const to = addDays(from, n);
  const why = cleanReason(reason);
  upsertLocation({
    ...location,
    subscription: {
      ...sub,
      trial: { ...sub.trial, endsOn: to, staffExtensions: [...(sub.trial.staffExtensions ?? []), { at: now.toISOString(), by: actor.id, days: n, from, to, reason: why }] },
    },
  });
  await staffAudit({ actor, action: "trial_extended", entity: "location", entityId: location.id, reason: why, before: { trialEndsOn: from }, after: { trialEndsOn: to, days: n } });
  return { ok: true, value: { to } };
}

export async function changePlan(actor: User, tenantId: string, locationId: unknown, productId: unknown, reason: unknown, now = new Date()): Promise<Result> {
  const auth = authorise(actor, tenantId);
  if (!auth.ok) return auth;
  const location = locationOf(auth.value, locationId);
  if (!location) return refuse(404, "No such location for this customer.");
  const sub = location.subscription;
  if (!sub) return refuse(409, "This location has no subscription yet. It gets one when the owner signs up for a plan or a trial.");
  if (!isProductId(productId) || !sellablePlans(location).some((p) => p.id === productId)) {
    return refuse(422, "Choose one of the plans on sale in this customer's country.");
  }
  const problem = reasonProblem(reason);
  if (problem) return refuse(422, problem);
  const from = productsOf(sub);
  if (from.length === 1 && from[0] === productId) return refuse(409, `Already on ${productById(productId).name}.`);
  const why = cleanReason(reason);
  upsertLocation({
    ...location,
    subscription: {
      ...sub,
      products: [productId],
      // A recorded plan is priced by today's catalogue, not the old sale price.
      priceMinor: undefined,
      planId: undefined,
      staffPlanChanges: [...(sub.staffPlanChanges ?? []), { at: now.toISOString(), by: actor.id, from, to: [productId], reason: why }],
    },
  });
  await staffAudit({ actor, action: "plan_changed", entity: "location", entityId: location.id, reason: why, before: { products: from }, after: { products: [productId], charged: false, paymentsOpen: stripeEnabled() } });
  return { ok: true, value: undefined };
}

/** Pause or restore the free trial: the abuse review's suspension, from the customer page. */
export async function setTrialSuspended(actor: User, tenantId: string, suspended: boolean, reason: unknown, now = new Date()): Promise<Result> {
  const auth = authorise(actor, tenantId);
  if (!auth.ok) return auth;
  const tenant = auth.value;
  const problem = reasonProblem(reason);
  if (problem) return refuse(422, problem);
  const onTrial = listLocationsFor(tenant.id).some((l) => l.subscription?.status === "trialing");
  if (suspended && !onTrial) return refuse(409, "Only a free trial can be suspended here. A paying customer's service follows their payments.");
  if (Boolean(tenant.abuse?.trialSuspendedAt) === suspended) return refuse(409, suspended ? "Already suspended." : "Not suspended.");
  const by = actor.name || actor.email;
  const why = cleanReason(reason);
  saveTenant({
    ...tenant,
    abuse: suspended
      ? { ...tenant.abuse, trialSuspendedAt: now.toISOString(), trialSuspendedBy: by }
      : { ...tenant.abuse, trialSuspendedAt: undefined, trialSuspendedBy: undefined },
  });
  await staffAudit({ actor, action: suspended ? "trial_suspended" : "trial_reactivated", entity: "tenant", entityId: tenant.id, reason: why, before: { suspended: !suspended }, after: { suspended } });
  return { ok: true, value: undefined };
}

export async function cancelAtPeriodEnd(actor: User, tenantId: string, locationId: unknown, reason: unknown, now = new Date()): Promise<Result> {
  const auth = authorise(actor, tenantId);
  if (!auth.ok) return auth;
  const location = locationOf(auth.value, locationId);
  if (!location) return refuse(404, "No such location for this customer.");
  const problem = reasonProblem(reason);
  if (problem) return refuse(422, problem);
  const sub = location.subscription;
  if (!sub || sub.status !== "active") return refuse(409, "Only an active paid plan can be cancelled at the end of its period.");
  const why = cleanReason(reason);
  upsertLocation({ ...location, subscription: { ...sub, status: "cancelled", cancelledAt: now.toISOString() } });
  await staffAudit({ actor, action: "plan_cancelled_at_period_end", entity: "location", entityId: location.id, reason: why, before: { status: "active" }, after: { status: "cancelled", stripeUpdated: false } });
  return { ok: true, value: undefined };
}

function userOf(tenant: Tenant, userId: unknown): User | undefined {
  const user = typeof userId === "string" ? getUser(userId) : undefined;
  return user && user.tenantId === tenant.id ? user : undefined;
}

/**
 * A password-reset link to hand over by hand, because nothing here sends
 * email. The same signed, single-use, 30-minute link the forgot-password form
 * emails (auth.ts `signResetToken`); asking again replaces it. The link is
 * returned once and never logged.
 */
export async function resetLinkFor(actor: User, tenantId: string, userId: unknown, now = Date.now()): Promise<Result<{ link: string; minutes: number }>> {
  const auth = authorise(actor, tenantId);
  if (!auth.ok) return auth;
  const user = userOf(auth.value, userId);
  if (!user) return refuse(404, "No such user for this customer.");
  if (user.disabled) return refuse(409, "This user is disabled. Enable them first.");
  const token = signResetToken(user, now);
  await staffAudit({ actor, action: "password_reset_link_made", entity: "user", entityId: user.id, after: { expiresInMinutes: RESET_LINK_MINUTES } });
  return { ok: true, value: { link: `${appOrigin()}/login/reset?t=${encodeURIComponent(token)}`, minutes: RESET_LINK_MINUTES } };
}

export async function confirmEmail(actor: User, tenantId: string, userId: unknown): Promise<Result> {
  const auth = authorise(actor, tenantId);
  if (!auth.ok) return auth;
  const user = userOf(auth.value, userId);
  if (!user) return refuse(404, "No such user for this customer.");
  if (!needsEmailVerification(user)) return { ok: true, value: undefined };
  const by = actor.name || actor.email;
  markEmailVerified(user.id, `staff: ${by}`);
  await staffAudit({ actor, action: "email_marked_confirmed", entity: "user", entityId: user.id, before: { confirmed: false }, after: { confirmed: true } });
  return { ok: true, value: undefined };
}

export async function setUserDisabled(actor: User, tenantId: string, userId: unknown, disabled: boolean, reason: unknown): Promise<Result> {
  const auth = authorise(actor, tenantId);
  if (!auth.ok) return auth;
  const user = userOf(auth.value, userId);
  if (!user) return refuse(404, "No such user for this customer.");
  const problem = reasonProblem(reason);
  if (problem) return refuse(422, problem);
  if (Boolean(user.disabled) === disabled) return refuse(409, disabled ? "Already disabled." : "Already enabled.");
  saveUser({ ...user, disabled: disabled || undefined });
  // Disabling signs them out everywhere, now, not at the next session expiry.
  if (disabled) deleteSessions({ userId: user.id });
  await staffAudit({ actor, action: disabled ? "user_disabled" : "user_enabled", entity: "user", entityId: user.id, reason: cleanReason(reason), before: { disabled: !disabled }, after: { disabled } });
  return { ok: true, value: undefined };
}
