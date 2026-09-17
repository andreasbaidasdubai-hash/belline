import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { listCalls } from "@/lib/store";
import { channelStatuses, factsFrom } from "@/lib/onboarding/journey";
import { CHANNEL_TABS } from "@/lib/nav";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import SectionTabs from "@/components/SectionTabs";
import { LinkSection } from "../sections";

export const dynamic = "force-dynamic";

export const metadata = { title: "Chat link" };

export default async function ChatLinkPage({ searchParams }: { searchParams: Promise<{ loc?: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  // Live, waiting or not set up: the same answer Home and setup give.
  const link = channelStatuses(location, factsFrom(location, listCalls(location.id))).find((c) => c.id === "link")!;

  return (
    <>
      <PageHeader title="Channels" subtitle={link.state === "not_set_up" ? "A chat with Belline that needs no website." : link.detail} />
      <LocationTabs base="/channels/link" active={location.id} />
      <SectionTabs tabs={CHANNEL_TABS} label="Channels" />
      <LinkSection location={location} live={link.state === "live"} />
    </>
  );
}
