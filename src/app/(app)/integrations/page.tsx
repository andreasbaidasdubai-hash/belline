import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { whatsappStatus } from "@/lib/whatsapp";
import { whatsappCard } from "@/lib/whatsapp-selfserve";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import WhatsAppCard from "./WhatsAppCard";

export const dynamic = "force-dynamic";

/**
 * WhatsApp, until it has its own page under Channels.
 *
 * Calendars, booking systems, reminder texts and deposits moved to /calendars;
 * this is what is left.
 */
export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const whatsapp = await whatsappStatus(location);
  const account = whatsapp.state === "connected" ? whatsapp.account : null;

  return (
    <>
      <PageHeader title="Integrations" subtitle="WhatsApp for your venue. Calendars and booking systems are on the Calendars page." />
      <LocationTabs base="/integrations" active={location.id} />

      {/*
        WhatsApp, the second-number way: the venue keeps its own WhatsApp
        untouched and Belle answers a number we register for it. Connected by
        us, shown here, and honest when it is not.
      */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">WhatsApp</div>
        <div style={{ padding: 18 }}>
          <WhatsAppCard
            locationId={location.id}
            venueName={location.name}
            card={location.demo?.enabled && !account ? { state: "soon" } : whatsappCard(location, whatsapp)}
            pendingName={location.whatsappPending?.displayName ?? null}
            notifyRequested={Boolean(location.onboarding?.integrationRequests?.includes("whatsapp"))}
          />
        </div>
      </div>
    </>
  );
}
