import type { Location, StaffMember } from "../types";
import { onBellineDiary, takesRequestsOnly } from "../booking/destination";

/**
 * The people a calendar venue books appointments with, as the Calendars page
 * edits them.
 *
 * Since the pivot the team editor is part of Belline's own diary (the Venue
 * page, the rota), and a business that books into Google Calendar or Outlook
 * never sees it. The engine still books a person, though: the calendar
 * provider (booking/calendar-provider.ts) runs the diary's own availability
 * search and then takes the calendar's busy times out, and that search only
 * offers a time with somebody on `salon.staff` who does the service and works
 * then. So "who uses which calendar" needs a way to say who there is.
 *
 * A person added here is the smallest record the engine accepts, with the
 * defaults onboarding gives a name typed on the review step: every service on
 * the list, the venue's opening hours, no time off. A rota, qualifications or
 * per-person prices stay diary features. Nothing here changes where bookings
 * go: the destination is on the onboarding record, and `onBellineDiary` reads
 * only that.
 *
 * Diary venues keep their team on the Venue page, where the rota and
 * qualifications live, so their people are only mapped here, never edited.
 */

export type PeopleChange =
  | { action: "add"; name: string }
  | { action: "rename"; staffId: string; name: string }
  | { action: "remove"; staffId: string };

export type PeopleResult = { ok: true; location: Location } | { ok: false; status: number; error: string };

const MAX_NAME = 60;

/** Can the owner add, rename and remove people on the Calendars page? */
export function canEditCalendarPeople(location: Location): boolean {
  return location.vertical !== "restaurant" && !onBellineDiary(location) && Boolean(location.google || location.outlook);
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "person";
}

function cleanName(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/** Apply one change to the venue. Returns the venue to save, or why not. */
export function changeCalendarPeople(location: Location, change: PeopleChange): PeopleResult {
  if (location.vertical === "restaurant") {
    return { ok: false, status: 422, error: "A restaurant books tables, not people, so every booking goes to the venue calendar." };
  }
  if (onBellineDiary(location)) {
    return { ok: false, status: 409, error: "Your team is kept on the Venue page, with their hours. Add or remove people there." };
  }
  if (!location.google && !location.outlook) {
    return { ok: false, status: 409, error: "Connect Google Calendar or Outlook first." };
  }

  const salon = location.salon ?? { services: [], staff: [], resources: [], slotMinutes: 15 };
  const staff = salon.staff;
  const nameTaken = (name: string, except?: string) =>
    staff.some((s) => s.id !== except && s.name.trim().toLowerCase() === name.toLowerCase());

  if (change.action === "add" || change.action === "rename") {
    const name = cleanName(change.name);
    if (!name) return { ok: false, status: 422, error: "Type their name." };
    if (name.length > MAX_NAME) return { ok: false, status: 422, error: `Keep the name under ${MAX_NAME} characters.` };
    if (change.action === "add") {
      if (nameTaken(name)) return { ok: false, status: 422, error: `${name} is already on the list.` };
      let id = `stf_${slug(name)}`;
      for (let n = 2; staff.some((s) => s.id === id); n++) id = `stf_${slug(name)}_${n}`;
      const person: StaffMember = {
        id,
        name,
        // The same defaults as a name typed on the review step (onboarding
        // applyDraft): nobody-does-anything would offer no time at all.
        serviceIds: salon.services.map((s) => s.id),
        hours: location.hours,
        timeOff: [],
      };
      return { ok: true, location: { ...location, salon: { ...salon, staff: [...staff, person] } } };
    }
    const person = staff.find((s) => s.id === change.staffId);
    if (!person) return { ok: false, status: 404, error: "That person is not on the list any more. Reload the page." };
    if (nameTaken(name, person.id)) return { ok: false, status: 422, error: `${name} is already on the list.` };
    return {
      ok: true,
      location: { ...location, salon: { ...salon, staff: staff.map((s) => (s.id === person.id ? { ...s, name } : s)) } },
    };
  }

  const person = staff.find((s) => s.id === change.staffId);
  if (!person) return { ok: false, status: 404, error: "That person is not on the list any more. Reload the page." };
  // The engine offers a time only with somebody on the list, so the last
  // person cannot go while the venue books straight into its calendar.
  if (staff.length === 1 && !takesRequestsOnly(location)) {
    return {
      ok: false,
      status: 422,
      error: "Belline books appointments with the people on this list, so keep at least one while bookings go into your calendar.",
    };
  }
  // Their own calendar goes with them, on whichever calendar is connected.
  const without = (map: Record<string, string> | undefined) =>
    map ? Object.fromEntries(Object.entries(map).filter(([id]) => id !== person.id)) : map;
  return {
    ok: true,
    location: {
      ...location,
      salon: { ...salon, staff: staff.filter((s) => s.id !== person.id) },
      ...(location.google ? { google: { ...location.google, staffCalendars: without(location.google.staffCalendars) } } : {}),
      ...(location.outlook ? { outlook: { ...location.outlook, staffCalendars: without(location.outlook.staffCalendars) } } : {}),
    },
  };
}
