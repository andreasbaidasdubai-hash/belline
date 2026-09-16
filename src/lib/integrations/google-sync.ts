import { recheckMisconfigured, sweepAbandonedConnects } from "./google";
import { retryCalendarSyncs } from "./calendar-sync";

/**
 * Every booking at a venue with a Google Calendar, in the calendar.
 *
 * The Google provider writes the agent's own bookings as it makes them. Every
 * other way a booking is made, moved or cancelled — the desk, the calendar
 * drag, a guest's manage link, a guest renamed — came through the booking
 * engine and, at a venue booking into Google, never reached Google at all. A
 * receptionist's booking then existed only in Belline, and the team looking at
 * their Google Calendar saw a free hour.
 *
 * That fix now serves Outlook as well, and lives in calendar-sync.ts. The
 * names below are the ones Google's callers and check:google have always used.
 */

export {
  SYNC_EXCEPTION_AFTER,
  queueCalendarSync as queueGoogleSync,
  resyncMovedCalendars,
  retryCalendarSyncs as retryGoogleSyncs,
  settleCalendarSync as settleGoogleSync,
  syncBooking,
  syncedByProvider,
  type SyncResult,
} from "./calendar-sync";

/**
 * Everything the server does for Google every few minutes: connections that
 * never came back, venues Google was refusing that it may accept again, and
 * bookings still waiting to be written — in that order, so a venue cleared by
 * the recheck has its waiting bookings written in the same sweep.
 */
export async function sweepGoogle(now = new Date()) {
  const abandoned = sweepAbandonedConnects(now);
  const recovered = await recheckMisconfigured();
  const bookings = await retryCalendarSyncs(now);
  return { abandoned, recovered, ...bookings };
}
