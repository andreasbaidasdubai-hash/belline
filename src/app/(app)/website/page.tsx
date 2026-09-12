import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { listCalls } from "@/lib/store";
import { todayIn } from "@/lib/time";
import { chatAllowed, voiceAllowed, WEBCHAT_DEFAULTS } from "@/lib/webchat";
import { EMBED_DEFAULTS, embedSnippet } from "@/lib/embed";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import WidgetEditor from "./WidgetEditor";

export const dynamic = "force-dynamic";

/**
 * Belline on the venue's own website.
 *
 * This existed for months with no way to switch it on. The endpoint was real,
 * the widget was real, the origin allowlist and the ceilings were real — and
 * the only way to use any of it was to POST to /api/embed by hand, which no
 * salon owner is going to do. A feature that ships without its screen has not
 * shipped; it has been written.
 *
 * The screen is deliberately blunt about one thing. This is the single setting
 * in Belline that lets strangers spend a venue's minutes, so it does not
 * present as a toggle: turning it on means naming the sites it may appear on,
 * and the day's usage is on the same screen as the switch rather than buried in
 * billing. Somebody turning this on should be able to see, a week later,
 * exactly what it cost them.
 */
export default async function WebsitePage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const embed = location.embed;
  const today = todayIn(location.timezone);
  const calls = listCalls(location.id).filter((c) => c.startedAt.slice(0, 10) === today);

  // Counted here rather than taken from the gates, because the gates answer
  // "may another one start" and this answers "what has it done today" — which
  // are the same number until the ceiling is reached and then are not.
  const used = {
    voice: calls.filter((c) => c.channel === "browser").length,
    chat: calls.filter((c) => c.channel === "webchat").length,
  };

  const origin = process.env.PUBLIC_APP_ORIGIN || "https://app.belline.ai";

  return (
    <>
      <PageHeader
        title="Your website"
        subtitle="A button in the corner of your own site. A visitor taps it and reaches the same receptionist as your phone — the same diary, the same prices, the same things it will not decide on its own."
      />
      <LocationTabs base="/website" active={location.id} />

      <WidgetEditor
        locationId={location.id}
        enabled={Boolean(embed?.enabled)}
        mode={embed?.mode ?? "both"}
        origins={embed?.allowedOrigins ?? []}
        snippet={embed?.enabled ? embedSnippet(location, origin) : ""}
        offering={{
          voice: voiceAllowed(embed),
          chat: chatAllowed(embed),
        }}
        used={used}
        limits={{
          voice: embed?.maxCallsPerDay ?? EMBED_DEFAULTS.maxCallsPerDay,
          chat: embed?.maxChatsPerDay ?? WEBCHAT_DEFAULTS.maxChatsPerDay,
        }}
        minutesCount={location.subscription ? true : false}
      />
    </>
  );
}
