import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import { getLocation, listBookings } from "@/lib/store";
import { listGuests } from "@/lib/guests";

export const dynamic = "force-dynamic";

/**
 * Find a returning guest while typing their name or number into a booking.
 *
 * The desk's most common booking is somebody who has been before, and typing
 * their name, number and email again is how a guest ends up as three people.
 */
export async function GET(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const url = new URL(req.url);
  const location = getLocation(url.searchParams.get("loc") ?? "");
  if (!location || !canSeeLocation(auth.user, location.id)) {
    return NextResponse.json({ error: "Unknown venue." }, { status: 404 });
  }

  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  if (q.length < 2) return NextResponse.json({ guests: [] });
  const digits = q.replace(/\D/g, "");

  const bookings = listBookings({ locationId: location.id });
  const guests = listGuests(location)
    .filter((g) => g.name.toLowerCase().includes(q) || (digits.length >= 3 && g.phone.replace(/\D/g, "").includes(digits)))
    .slice(0, 8)
    .map((g) => {
      const tail = g.phone.replace(/\D/g, "").slice(-9);
      const withEmail = bookings
        .filter((b) => b.guestEmail && tail && b.guestPhone.replace(/\D/g, "").endsWith(tail))
        .sort((a, b) => (b.date + b.startMin).localeCompare(a.date + a.startMin))[0];
      return {
        name: g.name,
        phone: g.phone,
        email: withEmail?.guestEmail ?? "",
        visits: g.visits,
        usual: g.usual ?? "",
        lastVisit: g.lastVisit ?? "",
        notes: g.notes.slice(0, 3),
      };
    });

  return NextResponse.json({ guests });
}
