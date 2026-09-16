import type { User } from "./types";
import { canManageUsers, isBellineStaff, visibleLocations } from "./auth";
import { simplifiedFor } from "./nav";
import { listBookings } from "./store";
import { listGuests, normalisePhone } from "./guests";
import { minutesToClock } from "./time";

/**
 * One search box for the whole dashboard (Ctrl+K).
 *
 * Bookings by reference, name or number; customers by name or number;
 * locations; and every page this person can open. Only ever across the venues
 * they can see — the same `visibleLocations` the switcher uses.
 */

export interface SearchHit {
  kind: "page" | "location" | "booking" | "customer";
  title: string;
  detail: string;
  href: string;
}

/**
 * Every page this person can open, whichever navigation they are on.
 *
 * Deliberately the union rather than the current shape. Search is how
 * somebody reaches a page that is not in front of them, so a venue on the
 * simplified navigation must still be able to type "rota" and get there —
 * that is the whole promise of moving pages to Advanced rather than removing
 * them. The simplified destinations are added on top when they apply, so the
 * labels somebody has just been reading are the ones that match.
 */
function pagesFor(user: User) {
  const simplified = simplifiedFor(visibleLocations(user));
  return [
    ...(simplified
      ? [
          { label: "Today", href: "/" },
          { label: "Conversations", href: "/conversations" },
          { label: "Requests", href: "/requests" },
          ...(user.role !== "staff" ? [{ label: "Channels", href: "/channels" }] : []),
          { label: "Everything else", href: "/advanced" },
        ]
      : [
          { label: "Needs you", href: "/attention" },
          { label: "Overview", href: "/" },
        ]),
    { label: "Calendar", href: "/calendar" },
    { label: "Floor", href: "/floor" },
    { label: "Calls", href: "/calls" },
    { label: "Messages", href: "/inbox" },
    { label: "Bookings", href: "/bookings" },
    { label: "Waitlist", href: "/waitlist" },
    { label: "Customers", href: "/guests" },
    { label: "Test console", href: "/test" },
    { label: "Go live", href: "/golive" },
    ...(user.role !== "staff"
      ? [
          { label: "Agent", href: "/agents" },
          { label: "How it works", href: "/venue" },
          { label: "Locations", href: "/locations" },
          { label: "Rota", href: "/rota" },
          { label: "Reports", href: "/reports" },
          { label: "Your website", href: "/website" },
          { label: "Integrations", href: "/integrations" },
          { label: "Set up with Belle", href: "/setup/assistant" },
        ]
      : []),
    ...(canManageUsers(user)
      ? [
          { label: "Plan and usage", href: "/billing" },
          { label: "Team", href: "/team" },
        ]
      : []),
    ...(isBellineStaff(user) ? [{ label: "Sales console", href: "/sales" }] : []),
  ];
}

export function searchEverything(user: User, raw: string, limit = 20): SearchHit[] {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const digits = q.replace(/\D/g, "");
  const ref = q.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const hits: SearchHit[] = [];

  for (const page of pagesFor(user)) {
    if (page.label.toLowerCase().includes(q)) hits.push({ kind: "page", title: page.label, detail: "Page", href: page.href });
  }

  const venues = visibleLocations(user);
  const many = venues.length > 1;
  for (const venue of venues) {
    if (venue.name.toLowerCase().includes(q)) {
      hits.push({ kind: "location", title: venue.name, detail: venue.address || venue.vertical, href: `/calendar?loc=${venue.id}` });
    }
  }

  for (const venue of venues) {
    const at = many ? ` · ${venue.name}` : "";
    const bookings = listBookings({ locationId: venue.id })
      .filter(
        (b) =>
          (ref.length >= 3 && b.ref === ref) ||
          b.guestName.toLowerCase().includes(q) ||
          (digits.length >= 4 && b.guestPhone.replace(/\D/g, "").includes(digits)),
      )
      .sort((a, b) => b.date.localeCompare(a.date) || b.startMin - a.startMin)
      .slice(0, 8);
    for (const b of bookings) {
      hits.push({
        kind: "booking",
        title: `${b.guestName} · ${b.date} ${minutesToClock(b.startMin)}`,
        detail: `${b.ref} · ${b.status}${at}`,
        href: `/calendar?loc=${venue.id}&date=${b.date}&open=${b.id}`,
      });
    }

    for (const g of listGuests(venue)) {
      if (g.name.toLowerCase().includes(q) || (digits.length >= 4 && g.phone.replace(/\D/g, "").includes(digits))) {
        hits.push({
          kind: "customer",
          title: g.name || g.phone,
          detail: `${g.phone} · ${g.visits} visit${g.visits === 1 ? "" : "s"}${at}`,
          href: `/guests/${normalisePhone(g.phone)}?loc=${venue.id}`,
        });
      }
    }
  }

  const order = { booking: 0, customer: 1, location: 2, page: 3 } as const;
  // An exact reference is what somebody reading one out wants, first.
  return hits
    .sort((a, b) => (a.kind === "booking" && a.detail.startsWith(ref) ? -1 : 0) - (b.kind === "booking" && b.detail.startsWith(ref) ? -1 : 0) || order[a.kind] - order[b.kind])
    .slice(0, limit);
}
