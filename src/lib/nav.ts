import type { Location, User } from "./types";
import { canManageUsers, isBellineStaff } from "./auth";
import { destinationOf } from "./booking/destination";

/**
 * What an owner sees down the left-hand side.
 *
 * This used to be a forty-line array inline in the app shell, which is why it
 * grew to twenty-two entries without anybody deciding that it should. It is
 * here now so that the shell, the command palette and the checks all read one
 * answer, and so the decision below is written down somewhere it can be
 * argued with.
 *
 * Belline no longer runs the customer's diary. It answers the phone, the
 * website and WhatsApp, answers from the business's own information, takes
 * booking requests and escalates what it should not decide. A navigation
 * built around a diary puts a dozen pages in front of that, and none of them
 * is the reason the owner opened the tab.
 *
 * So there are two shapes. The old one, unchanged. And a simplified one with
 * seven destinations, where everything else moves behind Advanced — still
 * routed, still linked, still tested, one click away instead of zero.
 */

export interface NavItem {
  href: string;
  label: string;
  badge?: number;
  quiet?: boolean;
}

export interface NavCounts {
  /** Items on the attention list, across every venue this person can see. */
  outstanding?: number;
  /** People due back, across the same venues. */
  dueBack?: number;
}

export interface NavShape {
  items: NavItem[];
  /** The Advanced entry, set only when there is an Advanced area to enter. */
  advanced: NavItem | null;
}

/**
 * Is this venue running on Belline's own diary?
 *
 * The one question that decides whether the diary pages are furniture or the
 * owner's daily work. A venue with no destination recorded predates the
 * journey and is on the diary — `destinationOf` says so, and the backfill in
 * seed.ts guarantees it.
 */
export function usesDiary(location: Pick<Location, "onboarding">): boolean {
  return destinationOf(location) === "belline";
}

/**
 * Does this person get the simplified navigation? Always, now.
 *
 * Until 2026-09-16 this was a flag plus a promise: a venue booking through
 * Belline's own diary kept the old twenty-two-link menu, so a pilot would not
 * lose its floor plan on the morning of the pivot. There were no such pilots —
 * only Belline's own demo lines — and the exception meant the founder, signed
 * in to the account holding those demo lines, kept seeing the old dashboard.
 * So the old navigation was retired. Every diary page is still one click away
 * under "Everything else", and search still reaches all of them.
 *
 * Kept as a function because search.ts asks the same question.
 */
export function simplifiedFor(_locations: Pick<Location, "onboarding">[]): boolean {
  return true;
}

/**
 * The seven destinations.
 *
 * Today first, because it is the only one that is ever urgent. Then the two
 * that answer "what happened" — every conversation on every channel, and
 * every booking request and what became of it. Then the three that answer
 * "how is it set up". Money and people last, and only for whoever is allowed
 * to see them.
 */
function simplifiedNav(user: User, counts: NavCounts): NavItem[] {
  const { outstanding = 0 } = counts;
  return [
    { href: "/", label: "Today", badge: outstanding || undefined },
    { href: "/conversations", label: "Conversations" },
    { href: "/requests", label: "Requests" },
    ...(user.role !== "staff"
      ? [
          { href: "/venue", label: "Setup" },
          { href: "/channels", label: "Channels" },
        ]
      : []),
    ...(canManageUsers(user)
      ? [
          { href: "/billing", label: "Billing and usage" },
          { href: "/team", label: "Team" },
        ]
      : []),
  ];
}

export interface AdvancedGroup {
  title: string;
  note: string;
  items: { href: string; label: string; note: string }[];
}

/**
 * Everything that is not one of the seven, grouped and explained.
 *
 * Not a dumping ground and not a deprecation notice. Each group says what it
 * is for, because the reason a page is here rather than in the navigation is
 * worth one sentence to the person looking for it.
 */
export function advancedGroups(user: User, locations: Location[]): AdvancedGroup[] {
  const hasTables = locations.some((l) => l.restaurant);
  const hasPeople = locations.some((l) => l.salon);
  const manager = user.role !== "staff";

  const groups: AdvancedGroup[] = [
    {
      title: "The diary",
      note:
        "Belline works with the calendar you already use, so most businesses never open these. They are the full booking diary, and they keep working for the venues that run on it.",
      items: [
        { href: "/calendar", label: "Calendar", note: "The day, by person or by room." },
        ...(hasTables ? [{ href: "/floor", label: "Floor", note: "The room as it stands right now." }] : []),
        { href: "/bookings", label: "Bookings", note: "Everything booked, by hand or by Belline." },
        { href: "/waitlist", label: "Waitlist", note: "People who wanted a time that was gone." },
        { href: "/recall", label: "Recall", note: "Who is due back, and what it is worth." },
        { href: "/guests", label: "Customers", note: "Everyone who has booked or called." },
        ...(hasPeople && manager ? [{ href: "/rota", label: "Rota", note: "Who is working, and when." }] : []),
      ],
    },
  ];

  if (manager) {
    groups.push({
      title: "How it answers",
      note: "The agent's own settings, and a line to try them on before your customers do.",
      items: [
        { href: "/agents", label: "Agent", note: "How it sounds and what it may say." },
        { href: "/setup/rules", label: "Booking and escalation rules", note: "What it asks for, and when it fetches a person." },
        { href: "/test", label: "Test console", note: "A real call against the real engine." },
        { href: "/setup", label: "Setup journey", note: "The guided setup, from the top." },
      ],
    });
  }

  if (canManageUsers(user)) {
    groups.push({
      title: "The account",
      note: "Branches, numbers and what the month looked like.",
      items: [
        { href: "/locations", label: "Locations", note: "Every branch, each with its own receptionist." },
        { href: "/reports", label: "Reports", note: "Calls, bookings and value over a period." },
        { href: "/golive", label: "Phone and going live", note: "Forwarding, the test call, and the switch." },
        { href: "/demo", label: "Demo line", note: "The numbers a prospect can ring." },
      ],
    });
  }

  // Belline's own tools. Never in a customer's navigation and never in a
  // customer's Advanced list — the pages guard themselves with notFound(),
  // and this keeps the link out of the one place a screen share would show
  // it. The sales console proper is still linked from the shell.
  if (isBellineStaff(user)) {
    groups.push({
      title: "Belline staff",
      note: "Ours, not the customer's. These are hidden from every other account.",
      items: [{ href: "/prospects", label: "Personalised demos", note: "Build a demo that answers as a prospect's business." }],
    });
  }

  return groups.filter((g) => g.items.length > 0);
}

/**
 * The navigation for this person, in this account.
 *
 * `locations` is already filtered to what they may see; this never widens it.
 */
export function navFor(user: User, _locations: Location[], counts: NavCounts = {}): NavShape {
  return {
    items: simplifiedNav(user, counts),
    advanced: { href: "/advanced", label: "Everything else" },
  };
}
