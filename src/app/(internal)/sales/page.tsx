import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { todayAttention, todayKpis } from "@/lib/staff/today";
import { ConsoleHeader, Stat, aed, ago } from "./ui";

export const dynamic = "force-dynamic";

/**
 * Today: what needs a person, and four numbers.
 *
 * The agent tree and the worker's numbers used to open the console. They are
 * the machine's view; they moved to Settings. The first screen is the list a
 * salesperson or a support person works down, most urgent first.
 */
export default async function TodayPage() {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const [{ groups, pipelineRead }, kpis] = await Promise.all([todayAttention(), Promise.resolve(todayKpis())]);
  const waiting = groups.reduce((n, g) => n + g.total, 0);

  return (
    <>
      <ConsoleHeader
        title="Today"
        subtitle={waiting === 0 ? "Nothing needs a person right now." : `${waiting} thing${waiting === 1 ? "" : "s"} need a person.`}
        actions={
          <Link href="/sales/leads" className="btn">
            All leads
          </Link>
        }
      />

      <div className="stats">
        <Stat label="Monthly revenue" value={aed(kpis.mrrFils)} hint="paid plans, in AED" tone={kpis.mrrFils > 0 ? "ok" : undefined} />
        <Stat label="Paying customers" value={String(kpis.activeCustomers)} hint="businesses on a paid plan" />
        <Stat label="On a trial" value={String(kpis.trials)} hint="businesses" />
        <Stat label="Signups, last 7 days" value={String(kpis.signups7d)} hint="new businesses" />
      </div>

      {!pipelineRead && (
        <p className="staff-note" style={{ marginBottom: 14 }}>
          Researched prospects and email drafts are not shown: the sales database is not connected. Enquiries, Belle&apos;s
          leads, the waitlist and every customer are.
        </p>
      )}

      <div className="staff-attention">
        {groups.map((g) => (
          <section key={g.id} className="panel staff-section" aria-labelledby={`today-${g.id}`}>
            <div className="panel-head">
              <span id={`today-${g.id}`}>{g.title}</span>
              <span className={`staff-count${g.total === 0 ? " zero" : ""}`}>{g.total}</span>
              {g.total > g.items.length && (
                <Link href={g.href} className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
                  See all
                </Link>
              )}
            </div>
            {g.items.length === 0 ? (
              <p className="staff-note" style={{ padding: "16px 18px" }}>
                {g.empty}
              </p>
            ) : (
              <ul>
                {g.items.map((item) => (
                  <li key={item.key}>
                    <Link href={item.href}>
                      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                        <span className="staff-attention-title">{item.title}</span>
                        {item.at && (
                          <span className="muted" style={{ marginLeft: "auto", fontSize: 11.5, whiteSpace: "nowrap" }}>
                            {ago(item.at)}
                          </span>
                        )}
                      </div>
                      <div className="staff-attention-detail">{item.detail}</div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
