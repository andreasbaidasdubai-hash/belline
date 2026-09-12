import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { visibleLocations } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { recallDue, recallSummary } from "@/lib/booking/recall";
import { terms } from "@/lib/verticals";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import RecallList from "./RecallList";

export const dynamic = "force-dynamic";

/**
 * Who is due back.
 *
 * The page a dental practice would buy this product for on its own. Recall is
 * the single biggest lever a clinic has on its own revenue, the industry
 * average is that a third of it never gets worked, and the reason is always
 * the same: it is a list somebody has to go through by hand, between patients,
 * and there is never a good moment.
 *
 * A salon has the identical list and no word for it — a root touch-up at six
 * weeks, a cut at eight — so this page is shared and only the wording changes.
 *
 * Nothing here is stored. Every row falls out of the bookings themselves; the
 * only writes are "I rang them" and "they asked me to try later", which are
 * facts about the outreach rather than about the visit.
 */
export default async function RecallPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string; show?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc, show } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  // The link appears in the sidebar because *some* venue this person can see
  // has people due back. If the venue that resolved is a restaurant, go to
  // the one that does rather than explaining why there is nothing here.
  if (!location.salon && !loc) {
    const diary = visibleLocations(user).find((l) => l.salon);
    if (diary) redirect(`/recall?loc=${diary.id}`);
  }

  const t = terms(location);
  const showSnoozed = show === "all";

  // A restaurant has no recall: nobody is "due back" for dinner, and pretending
  // otherwise would be the kind of feature that makes an operator distrust the
  // rest of the product.
  if (!location.salon) {
    return (
      <>
        <PageHeader title="Recall" subtitle="Who is due back, and what it is worth." />
        <LocationTabs base="/recall" active={location.id} />
        <div className="panel" style={{ padding: "30px 18px" }}>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Recall is a diary idea rather than a restaurant one — it tracks the people a
            treatment brings back on an interval. There is nothing to show for {location.name}.
          </p>
        </div>
      </>
    );
  }

  const withIntervals = location.salon.services.filter((s) => s.recallDays);
  const items = recallDue(location, { includeSnoozed: showSnoozed });
  const summary = recallSummary(location, { includeSnoozed: showSnoozed });

  return (
    <>
      <PageHeader
        title="Recall"
        subtitle={`The ${t.guests} a visit was supposed to bring back. Worked from the top: the people who stopped coming, before the people who are coming anyway.`}
        right={
          <Link className={`btn${showSnoozed ? " on" : ""}`} href={`/recall?loc=${location.id}${showSnoozed ? "" : "&show=all"}`}>
            {showSnoozed ? "Hide put-off" : "Show put-off"}
          </Link>
        }
      />
      <LocationTabs base="/recall" active={location.id} />

      {withIntervals.length === 0 ? (
        <div className="panel" style={{ padding: "30px 18px" }}>
          <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 600 }}>
            Nothing on the price list brings anybody back yet.
          </p>
          <p className="muted" style={{ margin: "0 0 14px", fontSize: 12.5, lineHeight: 1.55 }}>
            A recall interval is one number per {t.service}: six months for a hygiene visit, six
            weeks for a root touch-up, nothing at all for a filling. Set them and this list fills
            itself from the bookings you already have.
          </p>
          <Link className="btn" href={`/venue?loc=${location.id}`}>
            Set recall intervals
          </Link>
        </div>
      ) : (
        <>
          <div className="panel" style={{ padding: "14px 18px", marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 26, flexWrap: "wrap", alignItems: "baseline" }}>
              <Stat n={summary.overdue} label="overdue" bad={summary.overdue > 0} />
              <Stat n={summary.due} label="due now" />
              <Stat n={summary.upcoming} label="coming up" />
              <Stat n={summary.contacted} label="rung" />
              <Stat n={summary.booked} label="rebooked" />
              {summary.outstandingValue > 0 && (
                <div style={{ marginLeft: "auto", fontSize: 12.5 }} className="muted">
                  {/* The number an owner reacts to. At list price and said so:
                      an invented ROI figure is the fastest way to lose somebody
                      who knows their own numbers better than we do. */}
                  about {location.currency} {summary.outstandingValue.toLocaleString()} sitting in
                  this list, at list price
                </div>
              )}
            </div>
          </div>

          <RecallList
            locationId={location.id}
            currency={location.currency}
            guestWord={t.guest}
            items={items.map((i) => ({
              bookingId: i.fromBookingId,
              name: i.guestName,
              phone: i.guestPhone,
              service: i.serviceName,
              dueOn: i.dueOn,
              lastVisit: i.lastVisit,
              overdueDays: i.overdueDays,
              value: i.value,
              status: i.status,
              bookedFor: i.bookedFor,
              snoozedUntil: i.snoozedUntil,
            }))}
          />
        </>
      )}
    </>
  );
}

function Stat({ n, label, bad }: { n: number; label: string; bad?: boolean }) {
  return (
    <div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          color: bad ? "var(--bad)" : undefined,
        }}
      >
        {n}
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>
        {label}
      </div>
    </div>
  );
}
