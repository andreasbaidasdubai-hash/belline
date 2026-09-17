import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { CHANNEL_TABS } from "@/lib/nav";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import SectionTabs from "@/components/SectionTabs";
import { WhatsAppSection } from "../sections";

export const dynamic = "force-dynamic";

export const metadata = { title: "WhatsApp" };

/**
 * WhatsApp, the second-number way: the venue keeps its own WhatsApp untouched
 * and Belline answers a number registered for it. It used to sit on the
 * Integrations page between reminder texts and the calendars, which is not
 * where anybody looks for a way customers reach them.
 */
export default async function WhatsAppPage({ searchParams }: { searchParams: Promise<{ loc?: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  return (
    <>
      <PageHeader title="Channels" subtitle="Belline answers WhatsApp on a second number for your business, so your own WhatsApp stays as it is." />
      <LocationTabs base="/channels/whatsapp" active={location.id} />
      <SectionTabs tabs={CHANNEL_TABS} label="Channels" />
      <WhatsAppSection location={location} />
    </>
  );
}
