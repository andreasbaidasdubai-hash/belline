import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { PageHeader } from "@/components/LocationTabs";
import { getLocation, getTenant, listUsers } from "@/lib/store";
import { listAbuse, venueName } from "@/lib/abuse/review";
import { needsEmailVerification } from "@/lib/email-verify";
import { seedIfEmpty } from "@/lib/seed";
import type { AbuseRecord } from "@/lib/types";
import AbuseActions, { VerifyButton } from "./AbuseActions";

export const dynamic = "force-dynamic";

/**
 * Signups the abuse screening noticed (lib/abuse/review.ts), and owners whose
 * email is not confirmed yet (lib/email-verify.ts).
 *
 * Allow is the override: the account, address, network or browser is let
 * through from then on. Suspend stops the account's free trial (no paid setup
 * work, and the receptionist stops answering on the trial). Staff only,
 * checked here as well as in the layout.
 */

const STATUSES = [
  { id: "open", label: "To review" },
  { id: "noted", label: "Noted" },
  { id: "allowed", label: "Allowed" },
  { id: "suspended", label: "Suspended" },
  { id: "all", label: "All" },
] as const;

const KIND_LABEL: Record<AbuseRecord["kind"], string> = {
  duplicate_business: "Business already has an account",
  disposable_email: "Throwaway email address",
  ip_limit: "Too many trials from one network",
  device_limit: "Too many trials from one browser",
  many_signups_ip: "Several signups from one network today",
};

export default async function AbusePage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Not available.</p>;

  const { status } = await searchParams;
  const current = STATUSES.find((s) => s.id === status)?.id ?? "open";
  const rows = listAbuse({ status: current });
  const unconfirmed = listUsers().filter((u) => needsEmailVerification(u) && !u.disabled);

  return (
    <>
      <PageHeader title="Abuse review" subtitle={`${rows.length} shown · ${unconfirmed.length} emails not confirmed`} />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {STATUSES.map((s) => (
          <Link key={s.id} href={`/sales/abuse?status=${s.id}`} className={`btn${current === s.id ? " btn-accent" : ""}`}>
            {s.label}
          </Link>
        ))}
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        {rows.length === 0 ? (
          <p className="muted" style={{ padding: "26px 16px", fontSize: 13, margin: 0 }}>
            Nothing here. No signup on this filter looks like a second trial.
          </p>
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>When</th>
                  <th style={{ textAlign: "left" }}>What</th>
                  <th style={{ textAlign: "left" }}>Who</th>
                  <th style={{ textAlign: "left" }}>Matched</th>
                  <th style={{ textAlign: "left" }}>Notes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const tenant = r.tenantId ? getTenant(r.tenantId) : undefined;
                  const who = venueName(r.locationId) ?? tenant?.name;
                  const ip = r.ip ?? tenant?.signup?.ip;
                  const device = r.device ?? tenant?.signup?.device;
                  const matched = r.match ? getLocation(r.match.locationId) : undefined;
                  return (
                    <tr key={r.id} style={{ verticalAlign: "top" }} data-abuse={r.kind}>
                      <td>
                        <div className="mono" style={{ fontSize: 12 }}>
                          {r.lastAt.slice(0, 16).replace("T", " ")}
                        </div>
                        <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                          {r.stage ?? "signup"}
                          {r.count > 1 ? ` · ${r.count}×` : ""}
                        </div>
                        <span className="pill" style={{ marginTop: 6, display: "inline-block" }}>
                          {r.status}
                        </span>
                      </td>
                      <td style={{ fontWeight: 600, fontSize: 13 }}>{KIND_LABEL[r.kind]}</td>
                      <td style={{ fontSize: 12.5 }}>
                        {who && <div style={{ fontWeight: 600 }}>{who}</div>}
                        {r.email && <div>{r.email}</div>}
                        {ip && <div className="muted mono">IP {ip}</div>}
                        {device && (
                          <div className="muted mono" title="Browser id">
                            device {device.slice(0, 8)}…
                          </div>
                        )}
                        {tenant?.abuse?.allowedAt && <div style={{ color: "var(--ok)" }}>allowed by {tenant.abuse.allowedBy}</div>}
                        {tenant?.abuse?.trialSuspendedAt && (
                          <div style={{ color: "var(--bad)" }}>trial suspended by {tenant.abuse.trialSuspendedBy}</div>
                        )}
                      </td>
                      <td style={{ fontSize: 12.5 }}>
                        {r.match ? (
                          <>
                            <div>
                              {r.match.by}: <span className="mono">{r.match.value}</span>
                            </div>
                            <div className="muted">
                              {matched?.name ?? r.match.name} ({matched?.subscription?.status ?? "gone"})
                            </div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td style={{ fontSize: 12, maxWidth: 260 }}>
                        {r.notes.map((n) => (
                          <div key={n.at} style={{ marginBottom: 4 }}>
                            <span className="muted">{n.by}:</span> {n.text}
                          </div>
                        ))}
                      </td>
                      <td>
                        <AbuseActions id={r.id} status={r.status} canSuspend={Boolean(r.tenantId)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>Emails not confirmed</h2>
      <div className="panel">
        {unconfirmed.length === 0 ? (
          <p className="muted" style={{ padding: "20px 16px", fontSize: 13, margin: 0 }}>
            Every self-serve owner has confirmed their email.
          </p>
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Owner</th>
                  <th style={{ textAlign: "left" }}>Signed up</th>
                  <th style={{ textAlign: "left" }}>Codes sent</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {unconfirmed.map((u) => (
                  <tr key={u.id}>
                    <td style={{ fontSize: 12.5 }}>
                      <div style={{ fontWeight: 600 }}>{u.name}</div>
                      <div>{u.email}</div>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {u.createdAt.slice(0, 16).replace("T", " ")}
                    </td>
                    <td style={{ fontSize: 12.5 }}>{u.emailVerification?.sends?.length ?? 0}</td>
                    <td>
                      <VerifyButton userId={u.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
