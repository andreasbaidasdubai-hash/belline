import { googleConnector } from "../integrations/google";
import { calendarProvider } from "./calendar-provider";

/**
 * A business whose book is a Google Calendar.
 *
 * Availability is Belline's rules less the calendar's busy times; a booking is
 * an event whose id is derived from the idempotency key; a calendar that will
 * not take the event cancels the Belline record. The behaviour is shared with
 * Outlook and lives in calendar-provider.ts; Google's side of it is
 * `googleConnector` in integrations/google.ts.
 */
export const googleCalendarProvider = calendarProvider(() => googleConnector);
