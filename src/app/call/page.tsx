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

  /*
   * No chrome at all.
   *
   * This is framed as a small bar docked in the corner of belline.ai, and
   * everything that is not the call competes with it — a logo the site
   * already shows, a heading nobody reads mid-sentence, and a transcript that
   * turns a phone call into a chat window and invites people to read instead
   * of listen. The page it sits in provides all the context there is.
   */
  return (
    <Console
      locationId={location.id}
      locationName={location.name}
      demoToken={token}
      compact
      minimal
      auto
    />
  );
}
