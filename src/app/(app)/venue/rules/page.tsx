import { notFound } from "next/navigation";
import { canEditAgent } from "@/lib/auth";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { requestRulesOf } from "@/lib/booking/requests";
import { destinationOf, takesRequestsOnly } from "@/lib/booking/destination";
import { venueMarket } from "@/lib/onboarding/rules";
import { CLINIC_MEDICAL_RULE } from "@/lib/agent/prompt";
import { MARKETS } from "@/lib/markets";
import { businessTabs } from "@/lib/nav";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import SectionTabs from "@/components/SectionTabs";
import { RulesForm } from "@/app/setup/StepActions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Rules" };

/**
 * Your business → Rules: what Belline asks for, and when it fetches a person.
 *
 * "Booking and escalation rules" used to be a link into /setup/rules, so an
 * owner changing the urgent-call number from the dashboard was dropped into
 * onboarding, saved, and walked on to the next setup step. It is the same form
 * here, saved in place: the setup step and this page cannot disagree, because
 * they post the same answers to the same place.
 */
export default async function RulesPage({ searchParams }: { searchParams: Promise<{ loc?: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;
  if (!canEditAgent(user, location.id)) notFound();

  const o = location.onboarding;
  const rules = requestRulesOf(location);
  const requests = takesRequestsOnly(location);

  return (
    <>
      <PageHeader
        title="Your business"
        subtitle={
          requests
            ? "What Belline asks for when it takes a request, where it tells you, and when it puts a caller through to a person."
            : "When Belline puts a caller through to a person. Deposits, cancellations and house rules are under Agent and Diary settings."
        }
      />
      <LocationTabs base="/venue/rules" active={location.id} />
      <SectionTabs tabs={businessTabs(location)} label="Your business" />

      {!o?.destination ? (
        <p className="panel" role="status" style={{ padding: "14px 16px", fontSize: 13.5, lineHeight: 1.55, margin: 0 }}>
          These rules follow from where bookings go, which is not chosen yet.{" "}
          <a href="/setup/bookings">Choose where bookings go</a>
        </p>
      ) : (
        <div className="panel" style={{ padding: "18px 20px" }}>
          <RulesForm
            stay
            locationId={location.id}
            mode={destinationOf(location) === "belline" ? "belline" : "requests"}
            restaurant={location.vertical === "restaurant"}
            country={MARKETS[venueMarket(location)].name}
            countryIso={venueMarket(location)}
            initial={{
              askFor: rules.askFor.length > 0,
              transferNumber: o.escalation?.transferNumber || location.agent.transferNumber || location.businessPhone,
              notify: o.escalation?.notifyEmail || o.escalation?.notifyWhatsApp || "",
              afterHours: rules.afterHours,
              neverSay: rules.neverSay.join("\n"),
            }}
          >
            {location.vertical === "clinic" && (
              <div className="panel" style={{ padding: "14px 16px", margin: "22px 0 0" }}>
                <strong style={{ fontSize: 14 }}>Always on for clinics</strong>
                <p className="muted" style={{ margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.55 }}>
                  {CLINIC_MEDICAL_RULE}
                </p>
              </div>
            )}
          </RulesForm>
        </div>
      )}
    </>
  );
}
