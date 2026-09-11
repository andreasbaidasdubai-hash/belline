import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { signStreamToken } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { getLocation } from "@/lib/store";
import { BELLINE_LOCATION_ID } from "@/lib/seed-belline";
import Console from "../(app)/test/Console";

export const dynamic = "force-dynamic";

/**
 * Belline answering its own phone.
 *
 * The bell on belline.ai opens this in a panel, so a visitor can talk to the
 * product instead of reading about it. It is a real call: the same engine,
 * the same diary, the same refusals — pointed at our own venue, whose service
 * is a twenty-minute call with the sales director.
 *
 * That matters more than it sounds. A scripted demonstration flatters itself
 * and drifts from the product within a month. This one cannot: if the agent
 * gets worse, the thing on our front page gets worse with it, in public,
 * which is the strongest possible reason to keep it good.
 *
 * Public and unauthenticated by design — the whole point is that a stranger
 * can use it. The token is the entitlement, it names the venue, and it is
 * minted here rather than asked for, so the browser never gets to choose
 * which venue it would like to spend a call on.
 */

export const metadata: Metadata = {
  title: "Talk to Belline",
  // Not indexable: this is a widget meant to be opened from the site, not a
  // page that should turn up in a search for us.
  robots: { index: false, follow: false },
};

export default async function CallPage() {
  seedIfEmpty();

  const location = getLocation(BELLINE_LOCATION_ID);
  if (!location) notFound();

  const token = signStreamToken(location.id, 60 * 60);

  return (
    <div className="widget">
      <div className="widget-head">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.svg" alt="Belline" />
        <span className="widget-live">
          <span className="widget-dot" />
          Live call
        </span>
      </div>

      <p className="widget-lead">
        This is the same agent that answers our customers&apos; phones. Ask it
        anything about Belline, or let it book you twenty minutes with our
        sales director. Try to catch it out — that is rather the point.
      </p>

      <Console
        locationId={location.id}
        locationName={location.name}
        demoToken={token}
        compact
      />

      <p className="widget-foot">
        Belline books the call and takes your email, so it will ask you to
        spell it back. Nothing you say here reaches anyone until a booking is
        made, and there is nothing to pay.
      </p>
    </div>
  );
}
