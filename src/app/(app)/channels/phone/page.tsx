import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { listCalls } from "@/lib/store";
import { CHANNEL_TABS } from "@/lib/nav";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import SectionTabs from "@/components/SectionTabs";
import { PhoneSection } from "../sections";

export const dynamic = "force-dynamic";

export const metadata = { title: "Phone" };

/**
 * From "set up" to "answering my phone".
 *
 * One flow: get a Belline number, forward the line to it with codes that
 * already contain the number, and prove it with a test call the server
 * actually receives. The forwarding codes are the GSM supplementary-service
 * codes, which work on most mobile lines. Landlines and office phone systems
 * each do it their own way, and saying so is better than printing a code that
 * does nothing. The same section is the Phone & WhatsApp step of setup.
 */
export default async function PhonePage({ searchParams }: { searchParams: Promise<{ loc?: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const phoneCalls = listCalls(location.id).filter((c) => c.channel === "phone" && !c.isDemo && !c.isTest);
  const lastCall = phoneCalls.reduce<string | null>((a, c) => (!a || c.startedAt > a ? c.startedAt : a), null);

  return (
    <>
      <PageHeader
        title="Channels"
        subtitle="How Belline answers your real phone, if you want it to. Your customers keep dialling the number they already have, and nothing is forwarded until you dial a code yourself."
      />
      <LocationTabs base="/channels/phone" active={location.id} />
      <SectionTabs tabs={CHANNEL_TABS} label="Channels" />
      <PhoneSection location={location} skipHref={`/channels/website?loc=${location.id}`} />
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, margin: "4px 0 0" }}>
        {phoneCalls.length > 0 ? (
          <>
            Calls are arriving: the last one was {lastCall?.slice(0, 16).replace("T", " ")}.{" "}
            <Link href={`/conversations?loc=${location.id}&channel=phone`}>See the calls</Link>
          </>
        ) : (
          <>
            Once forwarding works, every call your team misses is answered as {location.name}. Until then,{" "}
            <Link href={`/channels?loc=${location.id}`}>Try it</Link> costs nothing.
          </>
        )}
      </p>
    </>
  );
}
