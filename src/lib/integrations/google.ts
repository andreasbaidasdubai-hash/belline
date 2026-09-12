import type { Booking, Location } from "../types";
import { getLocation, upsertLocation } from "../store";
import { describeBookingShort } from "../booking";
import { minutesToClock } from "../time";

/**
 * Google Calendar.
 *
 * Of the systems on the website this is the only one that can be built
 * without a commercial agreement: Fresha, SevenRooms, OpenTable and Treatwell
 * all issue credentials under contract, and no amount of code changes that.
 * Google is open, which makes it the integration that matters first — and for
 * a great many clinics and salons the diary really is a Google calendar.
 *
 * Deliberately one-way, and deliberately not the source of truth.
 *
 * Belline's engine knows things a calendar cannot: which stylist is qualified,
 * how many covers the kitchen can take at eight, that the chair is gone for
 * ten minutes after the guest leaves. A two-way sync would let an event
 * dragged in Google create a booking that breaks all three, silently. So
 * bookings are mirrored *out*, where the team already looks, and availability
 * is still decided here.
 *
 * The exception worth building later is reading *busy* blocks back — a
 * dentist's own dentist appointment in their personal calendar should make
 * them unbookable. That is a read of free/busy, not a write, and it does not
 * put the calendar in charge of anything.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";

export interface GoogleLink {
  calendarId: string;
  /** Long-lived. Exchanged for an access token on each use. */
  refreshToken: string;
  connectedAt: string;
  connectedBy: string;
  /** Set when a push last failed, so the dashboard can say so plainly. */
  lastError?: string;
  lastSyncedAt?: string;
}

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/**
 * Where Google sends the venue after they approve.
 *
 * `access_type=offline` with `prompt=consent` is what actually returns a
 * refresh token — without both, the first connection works and every one
 * after it silently returns no refresh token at all, which fails days later
 * when the access token expires.
 */
export function authUrl(locationId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    // The narrowest scope that can write events. Belline has no business
    // reading a venue's other calendars.
    scope: "https://www.googleapis.com/auth/calendar.events",
    state: locationId,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as { refresh_token?: string; error_description?: string };
  if (!res.ok || !data.refresh_token) {
    throw new Error(
      data.error_description ??
        "Google did not return a refresh token. Disconnect Belline in your Google account and try again.",
    );
  }
  return data.refresh_token;
}

async function accessToken(refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as { access_token?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? "Google refused the saved connection.");
  }
  return data.access_token;
}

/** A local wall-clock time in the venue's own zone, as Google wants it. */
function isoLocal(date: string, minutes: number): string {
  const hh = String(Math.floor(minutes / 60) % 24).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${date}T${hh}:${mm}:00`;
}

function eventFor(location: Location, booking: Booking) {
  return {
    // Deterministic, so pushing the same booking twice updates rather than
    // duplicates — the same reasoning as the booking fingerprint itself.
    // Google requires lowercase base32hex, so the id is not the raw one.
    id: `belline${booking.id.replace(/[^a-z0-9]/gi, "").toLowerCase()}`.slice(0, 60),
    summary: `${booking.guestName} — ${describeBookingShort(location, booking)}`,
    description: [
      `Booked through Belline (${booking.source}).`,
      booking.guestPhone ? `Phone: ${booking.guestPhone}` : null,
      booking.notes ? `Note: ${booking.notes}` : null,
      `Reference: ${booking.ref}`,
      "",
      "Belline owns availability. Changing this event does not change the booking.",
    ]
      .filter(Boolean)
      .join("\n"),
    start: { dateTime: isoLocal(booking.date, booking.startMin), timeZone: location.timezone },
    end: { dateTime: isoLocal(booking.date, booking.endMin), timeZone: location.timezone },
    status: booking.status === "confirmed" ? "confirmed" : "cancelled",
  };
}

/**
 * Mirror one booking into the venue's calendar.
 *
 * Never throws into a call. A calendar that is down must not stop a guest
 * being booked — the booking is real either way, and the mirror catches up.
 * The failure is recorded on the link so the dashboard can say "Google has
 * not accepted anything since Tuesday" rather than pretending all is well.
 */
export async function pushBooking(location: Location, booking: Booking): Promise<boolean> {
  const link = location.google;
  if (!link || !googleConfigured()) return false;

  try {
    const token = await accessToken(link.refreshToken);
    const event = eventFor(location, booking);

    // Upsert: PUT to a known id creates or replaces.
    const res = await fetch(
      `${API}/calendars/${encodeURIComponent(link.calendarId)}/events/${event.id}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(event),
      },
    );

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      noteFailure(location.id, `Google returned ${res.status}. ${detail}`);
      return false;
    }

    const fresh = getLocation(location.id);
    if (fresh?.google) {
      upsertLocation({
        ...fresh,
        google: { ...fresh.google, lastSyncedAt: new Date().toISOString(), lastError: undefined },
      });
    }
    return true;
  } catch (err) {
    noteFailure(location.id, err instanceof Error ? err.message : String(err));
    return false;
  }
}

function noteFailure(locationId: string, message: string): void {
  const location = getLocation(locationId);
  if (!location?.google) return;
  upsertLocation({ ...location, google: { ...location.google, lastError: message } });
  console.warn(`[google] ${location.name}: ${message}`);
}

/** What the dashboard shows about the connection. */
export function connectionState(location: Location): {
  connected: boolean;
  healthy: boolean;
  detail: string;
} {
  if (!googleConfigured()) {
    return {
      connected: false,
      healthy: false,
      detail: "Google Calendar isn't available on this account yet.",
    };
  }
  if (!location.google) {
    return { connected: false, healthy: false, detail: "Not connected." };
  }
  if (location.google.lastError) {
    return { connected: true, healthy: false, detail: location.google.lastError };
  }
  return {
    connected: true,
    healthy: true,
    detail: location.google.lastSyncedAt
      ? `Last wrote ${new Date(location.google.lastSyncedAt).toLocaleString()}`
      : "Connected. Nothing written yet.",
  };
}
