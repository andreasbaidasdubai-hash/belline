import { outlookConnector } from "../integrations/outlook";
import { calendarProvider } from "./calendar-provider";

/**
 * A business whose book is an Outlook calendar (Microsoft 365 or Outlook.com).
 *
 * The same provider as Google Calendar's (calendar-provider.ts): Belline's
 * rules less the calendar's busy times, one event per idempotency key, and no
 * booking kept that the calendar would not take. Microsoft's side of it —
 * Graph-assigned ids found again by a key property, rotating tokens — is
 * `outlookConnector` in integrations/outlook.ts.
 */
export const outlookCalendarProvider = calendarProvider(() => outlookConnector);
