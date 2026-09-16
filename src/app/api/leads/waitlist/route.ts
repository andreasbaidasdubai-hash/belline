import { createWaitlistLimiter, handleWaitlist } from "@/lib/leads/waitlist";
import { listLeads, saveLead } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * The waitlist on the German pages (/de-de, /de-at, /de-ch).
 *
 * Everything is in src/lib/leads/waitlist.ts, which check-leads runs directly:
 * validation, the signup route's rate limit, CORS for Belline's own website
 * origins only, and a plain German page for a browser without JavaScript.
 * Entries land in the leads store with source "dach-waitlist" and appear on
 * the staff Enquiries screen. Nothing is emailed.
 */

const limiter = createWaitlistLimiter();
const deps = { limiter, list: listLeads, save: (lead: Parameters<typeof saveLead>[0]) => void saveLead(lead) };

export async function OPTIONS(request: Request) {
  return handleWaitlist(request, deps);
}

export async function POST(request: Request) {
  return handleWaitlist(request, deps);
}
