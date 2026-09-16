import CalendarControls from "./CalendarControls";

/**
 * Which Google calendars Belline uses, and the way to disconnect. The form is
 * shared with Outlook (CalendarControls.tsx); the server checks every pick
 * against the calendars the Google account can add events to.
 */
export default function GoogleCalendarControls(props: {
  locationId: string;
  /** Null when they could not be loaded just now. */
  calendars: { id: string; name: string }[] | null;
  calendarId: string;
  staff: { id: string; name: string }[];
  staffCalendars: Record<string, string>;
}) {
  return <CalendarControls endpoint="/api/integrations/google" idPrefix="google" {...props} />;
}