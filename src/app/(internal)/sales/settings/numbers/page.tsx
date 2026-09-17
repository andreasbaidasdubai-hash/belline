import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { getLocation, listPoolRows } from "@/lib/store";
import { QUARANTINE_DAYS, poolSummary } from "@/lib/telephony/pool";
import { ConsoleHeader, EmptyState, Pill, Stat, day } from "../../ui";
import SettingsTabs from "../SettingsTabs";

export const dynamic = "force-dynamic";

/**
 * The pool of Belline numbers bought ahead and handed to new locations at Go
 * live (telephony/pool.ts). Read-only: numbers are added to the pool from the
 * command line, and a location's number is changed on its customer page.
 */
export default async function NumbersPage() {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const rows = [...listPoolRows()].sort((a, b) => a.status.localeCompare(b.status) || a.number.localeCompare(b.number));
  const summary = poolSummary();

  return (
    <>
      <ConsoleHeader title="Settings" subtitle="The number pool: Belline numbers bought ahead, given to a new location when it goes live." />
      <SettingsTabs active="/sales/settings/numbers" />

      <div className="stats">
        <Stat label="Free" value={String(summary.free)} tone={summary.free === 0 ? "warn" : undefined} hint="ready for the next location" />
        <Stat label="In use" value={String(summary.assigned)} />
        <Stat label="Resting" value={String(summary.quarantine)} hint={`given back, free again after ${QUARANTINE_DAYS} days`} />
      </div>

      <div className="panel">
        {rows.length === 0 ? (
          <EmptyState title="The pool is empty">
            Locations get their number from a person until numbers are added. Record one on the customer&apos;s page.
          </EmptyState>
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table className="staff-table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>State</th>
                  <th>Location</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const loc = r.locationId ? getLocation(r.locationId) : undefined;
                  return (
                    <tr key={r.number}>
                      <td className="mono">{r.number}</td>
                      <td>
                        <Pill tone={r.status === "free" ? "ok" : r.status === "assigned" ? "accent" : undefined}>{r.status === "free" ? "Free" : r.status === "assigned" ? "In use" : "Resting"}</Pill>
                      </td>
                      <td style={{ fontSize: 12.5 }}>{loc ? <Link href={`/sales/customers/${encodeURIComponent(loc.tenantId)}`}>{loc.name}</Link> : <span className="muted">—</span>}</td>
                      <td style={{ fontSize: 12.5 }}>{day(r.status === "assigned" ? r.assignedAt : r.status === "quarantine" ? r.releasedAt : r.addedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
