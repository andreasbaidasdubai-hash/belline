import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { guestProfile } from "@/lib/guest-profile";
import { dateToSpoken, minutesToClock } from "@/lib/time";
import { PageHeader } from "@/components/LocationTabs";
import GuestEditor from "./GuestEditor";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = {
  confirmed: "booked",
  completed: "came",
  cancelled: "cancelled",
  no_show: "no-show",
};

export default async function GuestProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { key } = await params;
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) notFound();
  const profile = guestProfile(location, decodeURIComponent(key));
  if (!profile) notFound();

  const { guest, bookings, calls, spend, email } = profile;
  const services = new Map((location.salon?.services ?? []).map((s) => [s.id, s.name]));
  const staff = new Map((location.salon?.staff ?? []).map((s) => [s.id, s.name]));
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = bookings.filter((b) => b.date >= today && b.status === "confirmed").reverse();
  const past = bookings.filter((b) => !(b.date >= today && b.status === "confirmed"));

  const Stat = ({ label, value }: { label: string; value: string | number }) => (
    <div className="panel" style={{ padding: "12px 14px" }}>
      <div className="muted" style={{ fontSize: 11.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 300, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );

  return (
    <>
      <PageHeader
        title={guest.name || guest.phone}
        subtitle={[guest.phone, email, guest.usual].filter(Boolean).join(" · ")}
        right={<Link className="btn" href={`/guests?loc=${location.id}`}>All customers</Link>}
      />

      <div className="stats" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 14 }}>
        <Stat label="Visits" value={guest.visits} />
        <Stat label="Last visit" value={guest.lastVisit ? dateToSpoken(guest.lastVisit, location.timezone) : "—"} />
        {location.salon && <Stat label="Spent" value={`${location.currency} ${spend.toLocaleString()}`} />}
        <Stat label="Cancelled" value={guest.cancellations} />
        <Stat label="No-shows" value={guest.noShows} />
      </div>

      <div className="split">
        <div>
          <div className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-head">Upcoming</div>
            {upcoming.length === 0 ? (
              <p className="muted" style={{ padding: "16px 18px", margin: 0, fontSize: 13 }}>Nothing booked.</p>
            ) : (
              <table>
                <tbody>
                  {upcoming.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <Link href={`/calendar?loc=${location.id}&date=${b.date}&open=${b.id}`} style={{ fontWeight: 600 }}>
                          {dateToSpoken(b.date, location.timezone)} · {minutesToClock(b.startMin)}
                        </Link>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {location.salon ? (b.serviceIds ?? []).map((id) => services.get(id)).filter(Boolean).join(", ") : `${b.partySize} covers`}
                          {b.staffId && staff.get(b.staffId) ? ` · ${staff.get(b.staffId)}` : ""}
                        </div>
                      </td>
                      <td className="mono" style={{ width: 70, textAlign: "right" }}>{b.ref}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <div className="panel-head">History</div>
            {past.length === 0 ? (
              <p className="muted" style={{ padding: "16px 18px", margin: 0, fontSize: 13 }}>No past visits yet.</p>
            ) : (
              <table>
                <tbody>
                  {past.map((b) => (
                    <tr key={b.id}>
                      <td>
                        {dateToSpoken(b.date, location.timezone)} · {minutesToClock(b.startMin)}
                        <div className="muted" style={{ fontSize: 12 }}>
                          {location.salon ? (b.serviceIds ?? []).map((id) => services.get(id)).filter(Boolean).join(", ") : `${b.partySize} covers`}
                          {b.notes ? ` · ${b.notes}` : ""}
                        </div>
                      </td>
                      <td style={{ width: 90, textAlign: "right" }}>
                        <span className="pill">{STATUS[b.status] ?? b.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div>
          <GuestEditor locationId={location.id} guestKey={profile.key} name={guest.name} email={email ?? ""} />

          {guest.notes.length > 0 && (
            <div className="panel" style={{ padding: "14px 16px", marginTop: 14 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Notes from visits</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: "var(--warn)" }}>
                {guest.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            </div>
          )}

          <div className="panel" style={{ marginTop: 14 }}>
            <div className="panel-head">Calls and chats</div>
            {calls.length === 0 ? (
              <p className="muted" style={{ padding: "16px 18px", margin: 0, fontSize: 13 }}>None from this number.</p>
            ) : (
              <table>
                <tbody>
                  {calls.slice(0, 20).map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/calls/${c.id}`}>{c.summary ?? "Conversation"}</Link>
                        <div className="muted" style={{ fontSize: 11.5 }}>{new Date(c.startedAt).toLocaleString("en-GB")} · {c.channel}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
