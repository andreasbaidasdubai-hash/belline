import { flag } from "../../flags";
import type { ProspectSource } from "./context";
import { demoStore, memoryFixtures } from "./store";

/**
 * A researched prospect for a stubbed local run, where there is no sales
 * database to read one from. Only ever loaded into the memory store, and only
 * while the stubs are on — which they refuse to be in production or next to a
 * real database. Made up: no such business.
 */
export const STUB_LEAD_ID = 4101;

export const STUB_PROSPECT: ProspectSource = {
  leadId: STUB_LEAD_ID,
  companyId: 9101,
  company: {
    name: "Harbourview Dental",
    city: "Dubai Marina",
    country_code: "AE",
    vertical_slug: "dentists",
    website: "https://harbourview-dental.example",
    domain: "harbourview-dental.example",
    email: "reception@harbourview-dental.example",
    has_whatsapp: true,
    booking_provider: null,
    booking_url: null,
    opening_hours: ["Monday: 9:00 AM – 9:00 PM", "Saturday: 10:00 AM – 6:00 PM", "Sunday: Closed"],
    location_count: 2,
    rating: 4.7,
    review_count: 312,
  },
  contact: { full_name: "Layla Haddad", email: "layla@harbourview-dental.example", language: "en" },
  research: {
    id: 77,
    summary:
      "Two-branch dental practice in Dubai Marina and JLT. Bookings are taken by phone and WhatsApp; there is no online booking. Open until 9pm on weekdays and on Saturdays.",
    signals: {
      multi_location: true,
      long_hours: true,
      weekend_open: true,
      appointment_based: true,
      online_booking: false,
      whatsapp_booking: true,
      phone_first: true,
      after_hours_gap: true,
      location_count: 2,
    },
    evidence: [
      { claim: "Books by phone and WhatsApp", quote: "Call or WhatsApp us to book your appointment", url: "https://harbourview-dental.example/contact" },
      { claim: "Open late on weekdays", quote: "Monday to Friday 9am – 9pm", url: "https://harbourview-dental.example/" },
      { claim: "Two branches", quote: "Our Dubai Marina and JLT clinics", url: "https://harbourview-dental.example/about" },
    ],
    created_at: "2026-09-10T08:00:00.000Z",
  },
  demo: null,
  demoServices: [
    { name: "Hygiene and cleaning" },
    { name: "Invisalign consultation" },
    { name: "Teeth whitening" },
  ],
};

/** Put the made-up prospect in the memory store, once, on a stubbed run. */
export async function ensureStubProspect(): Promise<void> {
  const store = demoStore();
  if (store.kind !== "memory" || !flag("stubs")) return;
  if (await store.loadSource(STUB_LEAD_ID)) return;
  memoryFixtures.putSource(STUB_PROSPECT);
}
