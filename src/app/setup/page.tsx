import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { listLocationsFor } from "@/lib/store";
import { journeyFor } from "@/lib/onboarding/journey";
import { seedIfEmpty } from "@/lib/seed";

export const dynamic = "force-dynamic";

/**
 * Setup resumes where the owner left off.
 *
 * Nothing here remembers a step: the journey is derived from what is saved, so
 * the next step after signing in again next week is the one the facts give.
 * `?manual=1` is the older "set it up by hand" link and opens the review.
 */
export default async function SetupPage({ searchParams }: { searchParams: Promise<{ manual?: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  const { manual } = await searchParams;

  const venue = listLocationsFor(user.tenantId)[0];
  // No venue means somebody invited to another account; the dashboard is theirs.
  if (!venue) redirect("/");
  if (manual === "1") redirect("/setup/review");

  redirect(journeyFor(venue).next?.url ?? "/");
}
