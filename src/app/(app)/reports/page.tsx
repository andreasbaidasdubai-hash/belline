import { notFound } from "next/navigation";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { buildReport } from "@/lib/reports";
import { addDays, todayIn } from "@/lib/time";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CHANNEL: Record<string, string> = { phone: "Phone", embed: "Website voice", webchat: "Website chat", whatsapp: "WhatsApp" };
const OUTCOME: Record<string, string> = {
  booking_created: "Booked",
  booking_changed: "Changed a booking",
  booking_cancelled: "Cancelled a booking",
  answered_question: "Answered a question",
  message_taken: "Took a message",
  transferred: "Put through to the team",
  abandoned: "Rang off",
  unfinished: "Not finished",
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function Bars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bars">
      {rows.map((r) => (
        <div key={r.label} className="bar-row">
          <span className="bar-label">{r.label}</span>
          <span className="bar-track"><span className="bar-fill" style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="bar-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ loc?: string; from?: string; to?: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  if (user.role === "staff") notFound();
  const { loc, from: rawFrom, to: rawTo } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const today = todayIn(location.timezone);
  const to = rawTo && DATE.test(rawTo) ? rawTo : today;
  const from = rawFrom && DATE.test(rawFrom) ? rawFrom : addDays(to, -29);
  const r = buildReport(location, from, to, today);
  const money = (n: number) => `${location.currency} ${n.toLocaleString()}`;
  const exportHref = (kind: string) => `/api/reports/export?loc=${location.id}&kind=${kind}&from=${from}&to=${to}`;
  const preset = (days: number) => `/reports?loc=${location.id}&from=${addDays(today, -(days - 1))}&to=${today}`;
  const restaurant = Boolean(location.restaurant);

  const Tile = ({ label, value, hint }: { label: string; value: string | number; hint?: string }) => (
    <div className="panel" style={{ padding: "14px 16px" }}>
      <div className="muted" style={{ fontSize: 11.5 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 300, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {hint && <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>{hint}</div>}
    </div>
  );

  return (
    <>
      <PageHeader title="Reports" subtitle={`${location.name}, ${from} to ${to}.`} />
      <LocationTabs base="/reports" active={location.id} />

      <form method="get" className="report-bar">
        <input type="hidden" name="loc" value={location.id} />
        <label>From<input type="date" name="from" defaultValue={from} /></label>
        <label>To<input type="date" name="to" defaultValue={to} /></label>
        <button className="btn">Show</button>
        <span className="report-presets">
          <a href={preset(7)}>7 days</a>
          <a href={preset(30)}>30 days</a>
          <a href={preset(90)}>90 days</a>
        </span>
        <span className="report-exports">
          Download:
          <a className="btn" href={exportHref("bookings")}>Bookings CSV</a>
          <a className="btn" href={exportHref("calls")}>Calls CSV</a>
          <a className="btn" href={exportHref("customers")}>Customers CSV</a>
        </span>
      </form>

      <div className="report-tiles">
        <Tile label="Bookings" value={r.bookings.total} hint={`${r.bookings.byBelle} by Belle · ${r.bookings.atDesk} at the desk`} />
        {restaurant ? <Tile label="Covers" value={r.bookings.covers} /> : <Tile label="Booked value" value={money(r.revenue)} hint="at list price" />}
        <Tile label="No-show rate" value={r.bookings.noShowRate === null ? "—" : `${Math.round(r.bookings.noShowRate * 100)}%`} hint={`${r.bookings.noShows} no-shows · ${r.bookings.cancelled} cancelled`} />
        <Tile label="Calls and chats" value={r.calls.total} hint={`${r.calls.minutes} min · ${r.calls.bookedOnCall} ended in a booking`} />
        <Tile label="Customers" value={r.customers.total} hint={`${r.customers.new} new · ${r.customers.returning} returning`} />
      </div>

      <div className="report-grid">
        <div className="panel">
          <div className="panel-head">Busiest days</div>
          <div style={{ padding: "12px 16px" }}>
            <Bars rows={WEEKDAYS.map((label, i) => ({ label, value: r.byWeekday[i] }))} />
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">Busiest hours</div>
          <div style={{ padding: "12px 16px" }}>
            {r.byHour.length ? <Bars rows={r.byHour.map((h) => ({ label: `${String(h.hour).padStart(2, "0")}:00`, value: h.count }))} /> : <p className="muted" style={{ margin: 0, fontSize: 13 }}>No bookings in this range.</p>}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">What calls and chats ended in</div>
          <div style={{ padding: "12px 16px" }}>
            {r.calls.total ? <Bars rows={Object.entries(r.calls.byOutcome).map(([k, v]) => ({ label: OUTCOME[k] ?? k, value: v }))} /> : <p className="muted" style={{ margin: 0, fontSize: 13 }}>No calls in this range.</p>}
            {r.calls.total > 0 && (
              <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
                {Object.entries(r.calls.byChannel).map(([k, v]) => `${CHANNEL[k] ?? k}: ${v}`).join(" · ")}
              </p>
            )}
          </div>
        </div>
        {!restaurant && (
          <div className="panel">
            <div className="panel-head">Services</div>
            {r.services.length ? (
              <table>
                <thead><tr><th>Service</th><th style={{ textAlign: "right" }}>Booked</th><th style={{ textAlign: "right" }}>Value</th></tr></thead>
                <tbody>{r.services.map((s) => <tr key={s.name}><td>{s.name}</td><td className="mono" style={{ textAlign: "right" }}>{s.count}</td><td className="mono" style={{ textAlign: "right" }}>{money(s.revenue)}</td></tr>)}</tbody>
              </table>
            ) : <p className="muted" style={{ padding: "12px 16px", margin: 0, fontSize: 13 }}>Nothing booked in this range.</p>}
          </div>
        )}
        {!restaurant && (
          <div className="panel">
            <div className="panel-head">Team</div>
            {r.staff.length ? (
              <table>
                <thead><tr><th>Person</th><th style={{ textAlign: "right" }}>Bookings</th><th style={{ textAlign: "right" }}>Value</th></tr></thead>
                <tbody>{r.staff.map((s) => <tr key={s.name}><td>{s.name}</td><td className="mono" style={{ textAlign: "right" }}>{s.count}</td><td className="mono" style={{ textAlign: "right" }}>{money(s.revenue)}</td></tr>)}</tbody>
              </table>
            ) : <p className="muted" style={{ padding: "12px 16px", margin: 0, fontSize: 13 }}>Nothing booked in this range.</p>}
          </div>
        )}
      </div>
    </>
  );
}
