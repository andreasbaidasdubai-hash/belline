import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { flag } from "@/lib/flags";
import { whatsappStatus } from "@/lib/whatsapp";
import { connectionState } from "@/lib/integrations/google";
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
 * The states are deliberately only these three, because the strategy document
 * is blunt about it: never show a channel as live until it is.
 *
 *   Live            — it is answering right now.
 *   Being prepared  — somebody at Belline is working on it, or we are waiting
 *                     on the owner to do one thing.
 *   Coming soon     — it is not available on this account at all.
 *
 * Phone and website state are read off the onboarding record rather than
 * through `verificationState`, which writes to the store when a test window
 * has lapsed. A page that summarises four channels should not have a side
 * effect on one of them; /golive is where that belongs.
 */

type State = "live" | "preparing" | "soon";

const TONE: Record<State, { text: string; colour: string }> = {
  live: { text: "Live", colour: "var(--ok)" },
  preparing: { text: "Being prepared", colour: "var(--warn)" },
  soon: { text: "Coming soon", colour: "var(--muted)" },
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

  const channels = location.onboarding?.channels;

  // Phone. Forwarding proved by a real call that arrived is the only thing
  // that counts as live — a number assigned is not a line answered.
  const phone = channels?.phone;
  const phoneState: State = phone?.forwardingVerifiedAt ? "live" : "preparing";
  const phoneDetail = phone?.forwardingVerifiedAt
    ? `Your line is forwarded to Belline and a test call came through. Customers keep dialling ${location.phone || "the number they already have"}.`
    : phone?.numberAssignedAt
      ? "You have a Belline number. Forward your line to it and make one test call, and this turns live."
      : flag("numbers.pool")
        ? "Get your Belline number, forward your line to it, and prove it with a test call."
        : "Your number is being prepared by the Belline team. Nothing for you to do yet.";

  // Website. Domains on the record mean the widget has been configured; the
  // install check on /website is what confirms it is actually on the page.
  const web = channels?.web;
  const webState: State = web?.detectedAt ? "live" : web?.domains?.length ? "preparing" : "soon";
  const webDetail = web?.detectedAt
    ? `The chat and voice button were found on ${web.domains.join(", ")}.`
    : web?.domains?.length
      ? `Set up for ${web.domains.join(", ")}, but the widget has not been seen on the page yet. Paste the snippet into your site and run the check.`
      : "Add a button to your own website and a visitor reaches the same receptionist as your phone. Choose the sites it may appear on to switch it on.";

  const whatsapp = await whatsappStatus(location);
  const whatsappState: State = whatsapp.state === "connected" ? "live" : "preparing";
  const whatsappDetail =
    whatsapp.state === "connected"
      ? "Belline answers your second WhatsApp number. Your own WhatsApp is untouched."
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
        action={phoneState === "live" ? "Phone settings" : "Set up forwarding"}
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
