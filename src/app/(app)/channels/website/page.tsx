import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { CHANNEL_TABS } from "@/lib/nav";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import SectionTabs from "@/components/SectionTabs";
import { WebsiteSection } from "../sections";

export const dynamic = "force-dynamic";

export const metadata = { title: "Website chat" };

/**
 * Belline on the venue's own website.
 *
 * The screen is deliberately blunt about one thing. This is the single setting
 * in Belline that lets strangers spend a venue's minutes, so it does not
 * present as a toggle: turning it on means naming the sites it may appear on,
 * and the day's usage is on the same screen as the switch rather than buried in
 * billing. The same section is the Website chat step of setup.
 */
export default async function WebsiteChatPage({ searchParams }: { searchParams: Promise<{ loc?: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  return (
    <>
      <PageHeader
        title="Channels"
        subtitle="A button in the corner of your own site. A visitor taps it and reaches the same receptionist as your phone, with the same answers and the same things it will not decide on its own."
      />
      <LocationTabs base="/channels/website" active={location.id} />
      <SectionTabs tabs={CHANNEL_TABS} label="Channels" />
      <WebsiteSection location={location} />
    </>
  );
}
