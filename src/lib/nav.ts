import type { Location, User } from "./types";
import { canManageUsers, isBellineStaff } from "./auth";
import { destinationOf, googleUsable, onBellineDiary, outlookUsable } from "./booking/destination";

/**
 * What an owner sees down the left-hand side.
 *
 * This used to be a forty-line array inline in the app shell, which is why it
 * grew to twenty-two entries without anybody deciding that it should. It is
 * here so that the shell, the phone menu, search and the checks all read one
 * answer, and so the decision below is written down somewhere it can be
 * argued with.
 *
 * Belline no longer runs the customer's diary. It answers the phone, the
 * website and WhatsApp, answers from the business's own information, takes
 * booking requests or books into the owner's own calendar, and escalates what
 * it should not decide. So the menu is the owner's day and the owner's setup,
 * in the words an owner uses (approved by the founder on 2026-09-17):
 *
 *   Home            what needs you, what was handled, the setup checklist
 *   Inbox           requests and conversations
 *   Bookings        only when Belline books into a connected calendar
 *   Customers
 *   Your business   details, services, questions, rules, the agent
 *   Channels        try it, website chat, phone, chat link, WhatsApp
 *   Calendars       Google, Outlook, booking systems, who uses which
 *   Settings        locations, team, billing and usage
 *
 * The diary pages (calendar, rota, waitlist, recall) are the owner's daily
 * work on the accounts that still run on Belline's own diary, so those
 * accounts get them as a group of their own. Nobody else sees them at all.
 *
 * "Everything else" is gone. It was the promise that nothing had been taken
 * away, and it became the place the product kept what it had not decided
 * about: the reports nobody read, a demo line only Belline uses, a link back
 * into setup. Every page a customer needs now has a place, and every old
 * address redirects to it (next.config.mjs).
 */

import type { NavGroup, NavItem } from "./nav-shape";
export { navItemOn, type NavGroup, type NavItem } from "./nav-shape";

export interface NavCounts {
  /** Items on the attention list, across every venue this person can see. */
  outstanding?: number;
  /** People due back, across the same venues. */
  dueBack?: number;
}

export interface NavShape {
  items: NavItem[];
  /** Belline's own diary, for the accounts that run on it. Null for everybody else. */
  diary: NavGroup | null;
  /** Belline's own tools, for Belline staff only. Null for every customer. */
  staff: NavGroup | null;
}

/**
 * Is this venue running on Belline's own diary?
 *
 * The one question that decides whether the diary pages exist for this owner.
 * See `onBellineDiary`: a venue from before the journey is on it, a new signup
 * that has not chosen where bookings go is not.
 */
export function usesDiary(location: Pick<Location, "onboarding">): boolean {
  return onBellineDiary(location);
}

/** Does Belline book into a calendar it can see for this venue? Then Bookings is a list worth having. */
export function booksIntoCalendar(location: Location): boolean {
  const kind = destinationOf(location);
  return (kind === "google" && googleUsable(location)) || (kind === "outlook" && outlookUsable(location));
}

/**
 * Where a diary page sends a venue that is not on the diary.
 *
 * The calendar, rota, waitlist, recall and floor are routes still, for the
 * accounts that use them, and an old bookmark on any other account should land
 * on where its bookings actually are: the bookings Belline made in its
 * calendar, or the requests its team confirms.
 */
export function notOnDiaryHome(location: Location): string {
  return `${booksIntoCalendar(location) ? "/bookings" : "/requests"}?loc=${encodeURIComponent(location.id)}`;
}

export const INBOX_MATCH = ["/requests", "/conversations", "/inbox", "/calls", "/attention"];
export const BUSINESS_MATCH = ["/venue", "/agents"];
export const SETTINGS_MATCH = ["/locations", "/team", "/billing", "/settings"];

function mainNav(user: User, locations: Location[], counts: NavCounts): NavItem[] {
  const { outstanding = 0 } = counts;
  const manager = user.role !== "staff";
  return [
    { href: "/", label: "Home", badge: outstanding || undefined },
    { href: "/requests", label: "Inbox", match: INBOX_MATCH },
    ...(locations.some(booksIntoCalendar) && !locations.some(usesDiary) ? [{ href: "/bookings", label: "Bookings" }] : []),
    { href: "/guests", label: "Customers" },
    ...(manager
      ? [
          { href: "/venue", label: "Your business", match: BUSINESS_MATCH },
          { href: "/channels", label: "Channels" },
          { href: "/calendars", label: "Calendars" },
        ]
      : []),
    ...(canManageUsers(user) ? [{ href: "/locations", label: "Settings", match: SETTINGS_MATCH }] : []),
  ];
}

function diaryNav(user: User, locations: Location[], counts: NavCounts): NavGroup | null {
  const diary = locations.filter(usesDiary);
  if (diary.length === 0) return null;
  const { dueBack = 0 } = counts;
  const hasTables = diary.some((l) => l.restaurant);
  const hasPeople = diary.some((l) => l.salon);
  return {
    title: "Diary",
    items: [
      { href: "/calendar", label: "Calendar" },
      ...(hasTables ? [{ href: "/floor", label: "Floor" }] : []),
      { href: "/bookings", label: "Bookings" },
      { href: "/waitlist", label: "Waitlist" },
      ...(hasPeople ? [{ href: "/recall", label: "Recall", badge: dueBack || undefined, quiet: true }] : []),
      ...(hasPeople && user.role !== "staff" ? [{ href: "/rota", label: "Rota" }] : []),
    ],
  };
}

/**
 * Belline's own tools. Never in a customer's navigation: the pages guard
 * themselves with notFound() as well, and this keeps the links out of the one
 * place a screen share would show them.
 */
function staffNav(user: User): NavGroup | null {
  if (!isBellineStaff(user)) return null;
  return {
    title: "Belline staff",
    items: [
      { href: "/sales", label: "Sales console" },
      { href: "/demo", label: "Demo line" },
      { href: "/prospects", label: "Personalised demos" },
    ],
  };
}

/**
 * The navigation for this person, in this account.
 *
 * `locations` is already filtered to what they may see; this never widens it.
 */
export function navFor(user: User, locations: Location[], counts: NavCounts = {}): NavShape {
  return { items: mainNav(user, locations, counts), diary: diaryNav(user, locations, counts), staff: staffNav(user) };
}

// ---------------------------------------------------------------------------
// The tabs inside each destination
// ---------------------------------------------------------------------------

export interface Tab {
  href: string;
  label: string;
}

export const INBOX_TABS: Tab[] = [
  { href: "/requests", label: "Requests" },
  { href: "/conversations", label: "Conversations" },
];

export const CHANNEL_TABS: Tab[] = [
  { href: "/channels", label: "Try it" },
  { href: "/channels/website", label: "Website chat" },
  { href: "/channels/phone", label: "Phone" },
  { href: "/channels/link", label: "Chat link" },
  { href: "/channels/whatsapp", label: "WhatsApp" },
];

/** Your business. The diary's own settings only where the venue runs on it. */
export function businessTabs(location: Pick<Location, "onboarding">): Tab[] {
  return [
    { href: "/venue", label: "Details" },
    { href: "/venue/rules", label: "Rules" },
    { href: "/agents", label: "Agent" },
    ...(usesDiary(location) ? [{ href: "/venue/diary", label: "Diary settings" }] : []),
  ];
}

export const SETTINGS_TABS: Tab[] = [
  { href: "/locations", label: "Locations" },
  { href: "/team", label: "Team" },
  { href: "/billing", label: "Billing and usage" },
];
