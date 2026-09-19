import { notFound } from "next/navigation";
import { canEditAgent, isBellineStaff } from "@/lib/auth";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { staticPrompt } from "@/lib/agent/prompt";
import { toolsFor } from "@/lib/agent/tools";
import { seedIfEmpty } from "@/lib/seed";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import AgentEditor from "./AgentEditor";
import { venueMarket } from "@/lib/onboarding/rules";
import { answersIn, languageChoiceOpen, savedLanguages, selectableLanguages } from "@/lib/language";
import LanguageSettings from "./LanguageSettings";
import VideoLook from "./VideoLook";
import { videoSettable } from "@/lib/video/availability";
import SectionTabs from "@/components/SectionTabs";
import { businessTabs } from "@/lib/nav";

export const dynamic = "force-dynamic";

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;
  // The nav hides this page from floor staff; this is what stops them simply
  // typing the address.
  if (!canEditAgent(user, location.id)) notFound();

  const prompt = staticPrompt(location);
  const tools = toolsFor(location);

  return (
    <>
      <PageHeader
        title="Your business"
        subtitle="How Belline introduces itself, how it sounds and the language it answers in. Takes effect on the next call — no deploy."
      />
      <LocationTabs base="/agents" active={location.id} />
      <SectionTabs tabs={businessTabs(location)} label="Your business" />

      <AgentEditor
        locationId={location.id}
        initial={location.agent}
        country={venueMarket(location)}
        initialLanguage={answersIn(location)}
        languageOpen={languageChoiceOpen()}
        videoSettings={
          // Only where the video receptionist is switched on for this venue and
          // its plan includes the voice button (video/availability.ts).
          videoSettable(location) ? (
            <VideoLook locationId={location.id} agentName={location.agent.displayName} />
          ) : undefined
        }
        languageSettings={
          <LanguageSettings
            locationId={location.id}
            initial={savedLanguages(location)}
            options={selectableLanguages().map((l) => ({ code: l.code, name: l.name, nativeName: l.nativeName, formality: l.formality }))}
          />
        }
      />

      {/* The tool list and the compiled prompt are how Belline debugs an agent,
          not settings an owner can act on. Staff only. */}
      {isBellineStaff(user) && (
      <>
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          Tools available to this agent
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
            generated from the venue type
          </span>
        </div>
        <div style={{ padding: 16, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {tools.map((t) => (
            <span key={t.name} className="pill mono" title={t.description}>
              {t.name}
            </span>
          ))}
        </div>
      </div>

      <details className="panel" style={{ marginTop: 16, padding: "13px 16px" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
          Compiled system prompt
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
            {prompt.length.toLocaleString()} characters, cached between turns
          </span>
        </summary>
        <pre
          className="mono muted"
          style={{
            fontSize: 11.5,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            marginTop: 14,
            marginBottom: 0,
          }}
        >
          {prompt}
        </pre>
      </details>
      </>
      )}
    </>
  );
}
