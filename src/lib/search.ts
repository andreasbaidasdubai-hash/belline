import type { User } from "./types";
import { canManageUsers, visibleLocations } from "./auth";
import { navFor, usesDiary } from "./nav";
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
 * Every page this person can open, by the names the menu and its tabs use,
 * and a few words people type for them ("reports", "test", "go live").
 *
 * The same rules as the menu (nav.ts): the diary's pages only for accounts on
 * Belline's own diary, the account's settings only for whoever may change
 * them, Belline's tools only for Belline staff. A page search offers is a page
 * that opens; a page the menu would not show is not offered here either.
 */
function pagesFor(user: User) {
  const locations = visibleLocations(user);
  const shape = navFor(user, locations);
  const manager = user.role !== "staff";
  const fromNav = [...shape.items, ...(shape.diary?.items ?? []), ...(shape.staff?.items ?? [])].map((i) => ({ label: i.label, href: i.href }));
  return [
    ...fromNav,
    { label: "Requests", href: "/requests" },
    { label: "Conversations", href: "/conversations" },
    { label: "Calls", href: "/conversations" },
    { label: "Messages", href: "/inbox" },
    { label: "Needs you", href: "/attention" },
    ...(manager
      ? [
          { label: "Try it (test console)", href: "/channels" },
          { label: "Website chat", href: "/channels/website" },
          { label: "Phone and forwarding (go live)", href: "/channels/phone" },
          { label: "Chat link", href: "/channels/link" },
          { label: "WhatsApp", href: "/channels/whatsapp" },
          { label: "Business details, services and questions", href: "/venue" },
          { label: "Rules and when to fetch a person", href: "/venue/rules" },
          { label: "Agent, voice and language", href: "/agents" },
          ...(locations.some(usesDiary) ? [{ label: "Diary settings", href: "/venue/diary" }] : []),
          { label: "Set up with Belle", href: "/setup/assistant" },
        ]
      : []),
    ...(canManageUsers(user)
      ? [
          { label: "Locations", href: "/locations" },
          { label: "Team", href: "/team" },
          { label: "Plan, billing and usage", href: "/billing" },
          { label: "Reports and downloads", href: "/" },
        ]
      : []),
  ];
}

export function searchEverything(user: User, raw: string, limit = 20): SearchHit[] {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const digits = q.replace(/\D/g, "");
  const ref = q.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const hits: SearchHit[] = [];

  const seen = new Set<string>();
  for (const page of pagesFor(user)) {
    if (seen.has(`${page.label}|${page.href}`)) continue;
    seen.add(`${page.label}|${page.href}`);
    if (page.label.toLowerCase().includes(q)) hits.push({ kind: "page", title: page.label, detail: "Page", href: page.href });
  }

  const venues = visibleLocations(user);
  const many = venues.length > 1;
  for (const venue of venues) {
    if (venue.name.toLowerCase().includes(q)) {
      hits.push({ kind: "location", title: venue.name, detail: venue.address || "Location", href: usesDiary(venue) ? `/calendar?loc=${venue.id}` : `/?loc=${venue.id}` });
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
        href: usesDiary(venue) ? `/calendar?loc=${venue.id}&date=${b.date}&open=${b.id}` : `/bookings?loc=${venue.id}`,
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
