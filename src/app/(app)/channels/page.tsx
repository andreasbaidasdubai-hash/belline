import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { flag } from "@/lib/flags";
import { whatsappStatus } from "@/lib/whatsapp";
import { connectionState } from "@/lib/integrations/google";
import { channelStatuses, factsFrom, type ChannelStatus } from "@/lib/onboarding/journey";
import { listCalls } from "@/lib/store";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";

export const dynamic = "force-dynamic";

export const metadata = { title: "Channels" };

/**
 * The four ways a customer can reach Belline, each with its real state.
 *
 * A hub, not a fifth implementation. Every status on this page is read from
 * the same function the channel's own screen reads, and every "set this up"
 * goes to that screen. The temptation with a page like this is to reimplement
 * the easy half of each flow inline and end up with two places that disagree
 * about whether WhatsApp is connected.
 *
 * Phone, website and WhatsApp use the one answer the journey gives
 * (`channelStatuses`), which Today and the setup steps show too:
 *
 *   Live        — it is answering real customers right now.
 *   Waiting     — connected or part way there, and not answering yet; it says why.
 *   Not set up  — nothing done on it.
 *
 * The calendar is a booking destination, not a channel, and keeps its own:
 *
 *   Being prepared  — somebody at Belline is working on it, or we are waiting
 *                     on the owner to do one thing.
 *   Coming soon     — it is not available on this account at all.
 *
 * Phone and website state are read off the onboarding record rather than
 * through `verificationState`, which writes to the store when a test window
 * has lapsed. A page that summarises four channels should not have a side
 * effect on one of them; /golive is where that belongs.
 */

type State = "live" | "preparing" | "soon" | ChannelStatus["state"];

const TONE: Record<State, { text: string; colour: string }> = {
  live: { text: "Live", colour: "var(--ok)" },
  preparing: { text: "Being prepared", colour: "var(--warn)" },
  soon: { text: "Coming soon", colour: "var(--muted)" },
  waiting: { text: "Waiting", colour: "var(--warn)" },
  not_set_up: { text: "Not set up", colour: "var(--muted)" },
};

function Channel({
  title,
  state,
  detail,
  href,
  action,
}: {
  title: string;
  state: State;
  detail: string;
  href: string;
  action: string;
}) {
  const tone = TONE[state];
  return (
    <section className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-head" style={{ display: "flex", gap: 10, alignItems: "center" }}>
        {title}
        <span className="pill" style={{ marginLeft: "auto", color: tone.colour }}>
          {tone.text}
        </span>
      </div>
      <div style={{ padding: "16px 18px", fontSize: 13.5, lineHeight: 1.6 }}>
        <p style={{ margin: 0, maxWidth: "70ch" }}>{detail}</p>
        <Link href={href} className="btn" style={{ marginTop: 14, display: "inline-block" }}>
          {action}
        </Link>
      </div>
    </section>
  );
}

export default async function ChannelsPage({
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
  // Live, waiting or not set up: the same answer Today and setup give.
  const status = Object.fromEntries(
    channelStatuses(location, factsFrom(location, listCalls(location.id)), { whatsappConnected: whatsapp.state === "connected" }).map((c) => [c.id, c]),
  ) as Record<ChannelStatus["id"], ChannelStatus>;

  // Phone. What to do next, under the one-line state.
  const phone = location.onboarding?.channels?.phone;
  const phoneState: State = status.phone.state;
  const phoneDetail =
    status.phone.state !== "not_set_up"
      ? status.phone.detail
      : flag("numbers.pool")
        ? "Get your Belline number, forward your line to it, and prove it with a test call."
        : "Your Belline number is being prepared by the Belline team. Nothing for you to do yet.";

  // Website.
  const web = location.onboarding?.channels?.web;
  const webState: State = status.web.state;
  const webDetail =
    status.web.state === "live" && web?.domains?.length
      ? `${status.web.detail} Found on ${web.domains.join(", ")}.`
      : status.web.state !== "not_set_up"
        ? status.web.detail
        : "Add a button to your own website and a visitor reaches the same receptionist as your phone. Choose the sites it may appear on to switch it on.";

  const whatsappState: State = status.whatsapp.state;
  const whatsappDetail =
    status.whatsapp.state !== "not_set_up"
      ? `${status.whatsapp.detail} Your own WhatsApp is untouched.`
      : whatsapp.state === "unavailable"
        ? "WhatsApp's status could not be checked just now. Nothing has changed; try again in a minute."
        : "Belline answers WhatsApp on a second number for the business. You get a new number and we set it up with you — your own WhatsApp stays as it is.";

  // Calendar. Two gates: whether the connection exists on this account at
  // all, and whether Google is still accepting the token.
  const googleOn = flag("booking.google");
  const google = connectionState(location);
  const calendarState: State = !googleOn ? "soon" : google.connected && google.healthy ? "live" : "preparing";
  const calendarDetail = !googleOn
    ? "Connecting your Google or Outlook calendar is not available on this account yet. Until it is, Belline takes booking requests and your team confirms them."
    : google.detail;

  return (
    <>
      <PageHeader
        title="Channels"
        subtitle="Where Belline answers, and where your bookings go. Each one says what is actually working today — not what is planned."
      />
      <LocationTabs base="/channels" active={location.id} />

      <Channel
        title="Phone"
        state={phoneState}
        detail={phoneDetail}
        href="/golive"
        action={phoneState === "live" || phone?.forwardingVerifiedAt ? "Phone settings" : "Set up forwarding"}
      />
      <Channel
        title="Your website"
        state={webState}
        detail={webDetail}
        href="/website"
        action={webState === "live" ? "Widget settings" : "Set up the widget"}
      />
      <Channel
        title="WhatsApp"
        state={whatsappState}
        detail={whatsappDetail}
        href="/integrations"
        action={whatsappState === "live" ? "WhatsApp settings" : "About WhatsApp"}
      />
      <Channel
        title="Calendar"
        state={calendarState}
        detail={calendarDetail}
        href="/integrations"
        action={calendarState === "live" ? "Calendar settings" : "Booking destinations"}
      />

      <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, marginTop: 18, maxWidth: "70ch" }}>
        Want to hear it before your customers do? The{" "}
        <Link href="/test" style={{ color: "var(--accent)" }}>
          test console
        </Link>{" "}
        puts you through to the same receptionist, on the real engine.
      </p>
    </>
  );
}
