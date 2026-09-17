import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { whatsappStatus } from "@/lib/whatsapp";
import { channelStatuses, factsFrom } from "@/lib/onboarding/journey";
import { listCalls } from "@/lib/store";
import { CHANNEL_TABS } from "@/lib/nav";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import SectionTabs from "@/components/SectionTabs";
import Console from "../test/Console";

export const dynamic = "force-dynamic";

export const metadata = { title: "Channels" };

/**
 * Channels, opening on "Try it".
 *
 * The first thing an owner wants from this screen is to hear it, so the test
 * console leads: a real conversation against the real engine, by voice or by
 * typing. Under it, each way in with its real state, read from the same
 * `channelStatuses` Home and the setup steps read:
 *
 *   Live        — it is answering real customers right now.
 *   Waiting     — connected or part way there, and not answering yet; it says why.
 *   Not set up  — nothing done on it.
 *
 * Each channel's own tab is where it is set up, and nothing here reimplements
 * the easy half of a flow. The calendar used to be listed here too; it is
 * where bookings go, not a way in, and has its own page now.
 */

const TONE = {
  live: { text: "Live", colour: "var(--ok)" },
  waiting: { text: "Waiting", colour: "var(--warn)" },
  not_set_up: { text: "Not set up", colour: "var(--text-2)" },
} as const;

export default async function ChannelsPage({ searchParams }: { searchParams: Promise<{ loc?: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const whatsapp = await whatsappStatus(location);
  const statuses = channelStatuses(location, factsFrom(location, listCalls(location.id)), { whatsappConnected: whatsapp.state === "connected" });

  return (
    <>
      <PageHeader title="Channels" subtitle="Try Belline yourself, then choose where your customers can reach it. Each channel says what is actually working today." />
      <LocationTabs base="/channels" active={location.id} />
      <SectionTabs tabs={CHANNEL_TABS} label="Channels" />

      <section aria-labelledby="try-it" style={{ marginBottom: 18 }}>
        <h2 id="try-it" style={{ fontSize: 16, fontWeight: 600, margin: "0 0 4px" }}>
          Try it
        </h2>
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.55, margin: "0 0 12px", maxWidth: "68ch" }}>
          Talk or type to your receptionist, on the real engine, before your customers do.
        </p>
        <Console locationId={location.id} locationName={location.name} />
      </section>

      <section className="panel" data-testid="channel-statuses">
        <div className="panel-head">Where Belline answers</div>
        <ul style={{ listStyle: "none", margin: 0, padding: "6px 18px 12px" }}>
          {statuses.map((c) => (
            <li key={c.id} data-channel={c.id} data-state={c.state} style={{ padding: "10px 0", borderBottom: "1px solid var(--border-soft)", fontSize: 13.5, lineHeight: 1.5 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <Link href={c.href} style={{ fontWeight: 600 }}>
                  {c.label}
                </Link>
                <span className="pill" style={{ marginLeft: "auto", color: TONE[c.state].colour }}>
                  {TONE[c.state].text}
                </span>
              </div>
              <span style={{ color: "var(--text-2)", display: "block", marginTop: 2 }}>{c.detail}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
