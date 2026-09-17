import Link from "next/link";
import { redirect } from "next/navigation";
import Brand from "@/components/Brand";
import { requireUser } from "@/lib/auth-server";
import { listCalls, listLocationsFor } from "@/lib/store";
import { currentVenue } from "@/lib/onboarding";
import {
  INTEGRATIONS,
  RENAMED_STEPS,
  bellineDiaryOffered,
  channelStatuses,
  checklistOf,
  factsFrom,
  isStepId,
  journey,
  stepAfter,
  type ChannelStatus,
  type Journey,
  type Step,
} from "@/lib/onboarding/journey";
import { venueMarket } from "@/lib/onboarding/rules";
import { setupGreeting } from "@/lib/onboarding/assistant";
import { requestRulesOf } from "@/lib/booking/requests";
import { destinationOf, googleUsable, onBellineDiary, outlookUsable, serviceLengthsRequired, takesRequestsOnly } from "@/lib/booking/destination";
import { OUTLOOK_NO_CALENDAR_TEXT } from "@/lib/integrations/outlook";
import { integrationErrorText } from "@/lib/errors/customer";
import { CLINIC_MEDICAL_RULE } from "@/lib/agent/prompt";
import { MARKETS } from "@/lib/markets";
import { flag } from "@/lib/flags";
import { ownerTickets } from "@/lib/exceptions";
import { whatsappStatus } from "@/lib/whatsapp";
import { whatsappCard } from "@/lib/whatsapp-selfserve";
import { seedIfEmpty } from "@/lib/seed";
import type { Location } from "@/lib/types";
import { SCENARIO_ORDER, scenarioTitle } from "@/lib/onboarding/selftest";
import { selftestAvailable, testsPassed, testsStale } from "@/lib/onboarding/selftest-state";
import BelleDock from "../BelleDock";
import { belleFaceUrl, supportVideoOn } from "@/lib/belle/identity";
import { onViewAs } from "@/lib/belle/server";
import SetupWizard from "../SetupWizard";
import SelftestPanel from "../SelftestPanel";
import { LinkSection, PhoneSection, WebsiteSection, WhatsAppSection } from "@/app/(app)/channels/sections";
import { ActionButton, DestinationPicker, RulesForm, SkipLink, type DestinationOption } from "../StepActions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Set up Belline" };

/**
 * One setup, one step at a time, in any order.
 *
 * Outside the `(app)` group so a step has the whole screen, and never a wall:
 * every step opens whatever was done before it, every step can be skipped, and
 * the dashboard is one press away in the header. What is left shows as a
 * checklist on Home. Answering real customers is gated separately, per
 * channel, by Go live (onboarding/journey.ts).
 *
 * Every step has one primary button, placed before any detail so it is on
 * screen on a phone without scrolling, and again at the bottom beside "Skip
 * for now", so an owner who reads to the end is not left with only a way to
 * skip. Each step is done in place: the website chat and the phone render the
 * same sections as the Channels screens, rather than sending the owner out to
 * the dashboard and back.
 *
 * The step is in the URL and everything on it is read from what is saved, so
 * a refresh, or signing in again next week, shows the same step.
 */

const serif = { fontFamily: "var(--bl-font-display)", fontWeight: 700 } as const;
const eyebrow = { fontSize: 11.5, letterSpacing: "0.16em", textTransform: "uppercase", margin: "0 0 14px", color: "var(--gold-ink)" } as const;
const lede = { color: "var(--text-2)", fontSize: 15.5, lineHeight: 1.6, maxWidth: "56ch", margin: "0 0 22px" } as const;
const primary = { padding: "12px 22px", display: "inline-block" } as const;

function Heading({ step, title }: { step: Step; title: string }) {
  return (
    <>
      <p className="muted" style={eyebrow}>
        Step {step.n} · {step.title}
      </p>
      <h1 style={{ ...serif, fontSize: 30, letterSpacing: "-0.02em", lineHeight: 1.12, margin: "0 0 12px" }}>{title}</h1>
    </>
  );
}

const STATE_WORD: Record<ChannelStatus["state"], string> = { live: "Live", waiting: "Waiting", not_set_up: "Not set up" };

/** Each channel, and whether it is answering real customers. */
function ChannelList({ statuses }: { statuses: ChannelStatus[] }) {
  return (
    <ul style={{ listStyle: "none", margin: "18px 0 0", padding: 0, display: "grid", gap: 8 }} data-testid="channel-statuses">
      {statuses.map((c) => (
        <li key={c.id} className="panel" style={{ padding: "12px 14px" }} data-channel={c.id} data-state={c.state}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 14 }}>{c.label}</strong>
            <span className="pill" style={{ marginLeft: "auto", color: c.state === "live" ? "var(--ok)" : c.state === "waiting" ? "var(--warn)" : "var(--text-2)" }}>
              {STATE_WORD[c.state]}
            </span>
          </div>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.5, margin: "4px 0 0" }}>
            {c.detail}
          </p>
        </li>
      ))}
    </ul>
  );
}

function Rail({ j, active }: { j: Journey; active: Step }) {
  const checklist = checklistOf(j);
  return (
    <>
      <style>{`
        .setup-grid { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 40px; }
        .setup-rail-compact { display: none; }
        @media (max-width: 760px) {
          .setup-grid { grid-template-columns: minmax(0, 1fr); gap: 0; }
          .setup-rail { display: none; }
          .setup-rail-compact { display: block; }
        }
      `}</style>
      <nav aria-label="Setup steps" className="setup-rail">
        {/* Every step opens, in any order. Nothing here is a gate. */}
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
          {j.steps.map((s) => (
            <li key={s.id}>
              <Link
                href={s.url}
                aria-current={s.id === active.id ? "step" : undefined}
                style={{
                  display: "block",
                  padding: "7px 10px",
                  borderRadius: 8,
                  fontSize: 13.5,
                  background: s.id === active.id ? "var(--panel-2)" : "transparent",
                  fontWeight: s.id === active.id ? 600 : 400,
                  color: "var(--text)",
                }}
              >
                <span aria-hidden="true" style={{ width: 20, display: "inline-block", color: s.done ? "var(--ok)" : "var(--text-2)" }}>
                  {s.done ? "✓" : s.n}
                </span>
                {s.title}
                {s.optional && (
                  <span className="muted" style={{ fontSize: 11.5, marginLeft: 6 }}>
                    optional
                  </span>
                )}
                {s.done && <span className="sr-only"> (done)</span>}
              </Link>
            </li>
          ))}
        </ol>
      </nav>
      <p className="setup-rail-compact muted" style={{ fontSize: 12.5, margin: "0 0 18px" }}>
        Step {active.n} of {j.steps.length} · {checklist.done} of {checklist.total} done
      </p>
    </>
  );
}

/**
 * The Google card. With `booking.google` off it is "Coming soon", as before.
 * With it on, it can be chosen only once a working connection exists; until
 * then it offers the connection, and an expired one says so.
 */
function googleCard(venue: Location): DestinationOption {
  const title = "Google Calendar";
  if (!flag("booking.google")) {
    return { id: "google", title, state: "soon", body: "Coming soon. Belline starts with requests, and you can ask to be told when it is ready." };
  }
  const connectUrl = `/api/integrations/google?locationId=${encodeURIComponent(venue.id)}&from=setup`;
  if (googleUsable(venue)) {
    const name = venue.google?.calendarName ?? "your calendar";
    return { id: "google", title, body: `Belline checks ${name} for busy times and adds each booking to it.`, state: "available" };
  }
  if (venue.google?.expiredAt) {
    return { id: "google", title, state: "connect", connectUrl, body: "Google stopped letting Belline in. Connect it again to use it; until then Belline takes requests." };
  }
  return { id: "google", title, state: "connect", connectUrl, body: "Connect your Google account first. Belline only reads busy times and adds bookings on the calendars you pick." };
}

/** What the page says after Google sends the owner back here. */
function googleNotice(code: string | undefined): string | undefined {
  if (code === "declined") return integrationErrorText("google_declined") ?? undefined;
  if (code === "connected") return "Google Calendar is connected. Choose it below and press Use this.";
  if (code === "google_unavailable" || code === "google_refused" || code === "google_failed") return integrationErrorText(code) ?? undefined;
  return undefined;
}

/**
 * The Outlook card, as Google's: "Coming soon" with `booking.outlook` off;
 * with it on, chosen only once a working connection exists, and until then it
 * offers the connection and says what stands in the way.
 */
function outlookCard(venue: Location): DestinationOption {
  const title = "Outlook calendar";
  if (!flag("booking.outlook")) {
    return { id: "outlook", title, state: "soon", body: "Coming soon. Belline starts with requests, and you can ask to be told when it is ready." };
  }
  const connectUrl = `/api/integrations/microsoft?locationId=${encodeURIComponent(venue.id)}&from=setup`;
  if (outlookUsable(venue)) {
    const name = venue.outlook?.calendarName ?? "your calendar";
    return { id: "outlook", title, body: `Belline checks ${name} for busy times and adds each booking to it.`, state: "available" };
  }
  if (venue.outlook?.expiredAt) {
    const body = venue.outlook.lastError === OUTLOOK_NO_CALENDAR_TEXT ? OUTLOOK_NO_CALENDAR_TEXT : "Microsoft stopped letting Belline in. Connect it again to use it; until then Belline takes requests.";
    return { id: "outlook", title, state: "connect", connectUrl, body };
  }
  if (venue.outlookAdminApprovalAt && !venue.outlook) {
    return { id: "outlook", title, state: "connect", connectUrl, body: "Your organisation's IT admin has to approve Belline first. Once they have, connect your Microsoft account here." };
  }
  return { id: "outlook", title, state: "connect", connectUrl, body: "Connect your Microsoft 365 or Outlook.com account first. Belline only reads busy times and adds bookings on the calendars you pick." };
}

/** What the page says after Microsoft sends the owner back here. */
function outlookNotice(code: string | undefined): string | undefined {
  if (code === "declined") return integrationErrorText("outlook_declined") ?? undefined;
  if (code === "connected") return "Outlook is connected. Choose it below and press Use this.";
  return code?.startsWith("outlook_") ? (integrationErrorText(code) ?? undefined) : undefined;
}

/** The bookings step's cards. Google follows `googleCard`, Outlook `outlookCard`. */
function destinationOptions(venue: Location): DestinationOption[] {
  const clinicPreview = venue.vertical === "clinic" && !flag("vertical.clinic.selfserve");
  return [
    {
      id: "requests",
      title: "My team confirms each booking",
      body: "Belline takes the customer's details and the time they want, and tells them your team will confirm. Each request arrives in your Inbox for your team to confirm.",
      state: "available",
    },
    {
      id: "link",
      title: "I have a booking link",
      body: "The same, and in chats Belline also gives people your own booking link.",
      state: "available",
    },
    ...(bellineDiaryOffered(venue)
      ? [
          {
            id: "belline",
            title: "Belline's diary",
            body: "Belline books straight into the calendar in your dashboard, and your team sees every booking there.",
            state: "available",
          } satisfies DestinationOption,
        ]
      : []),
    ...(clinicPreview ? [] : [googleCard(venue), outlookCard(venue)]),
  ];
}

const PARTNERS = ["fresha", "sevenrooms", "opentable", "treatwell", "other"].map((id) => ({ id, name: INTEGRATIONS[id] }));

/** The bottom of a step whose main button is a link: that link again, and Skip for now. */
function Footer({ step, skip, children }: { step: Step; skip: string; children?: React.ReactNode }) {
  return (
    <div className="setup-footer">
      {children}
      {!step.done && step.id !== "first-week" && <SkipLink href={skip} />}
    </div>
  );
}

function Body({
  step,
  j,
  venue,
  facts,
  google,
  outlook,
  whatsappLive,
}: {
  whatsappLive: boolean;
  step: Step;
  j: Journey;
  venue: Location;
  facts: ReturnType<typeof factsFrom>;
  google?: string;
  outlook?: string;
}) {
  // Onward from this step, to the next one not done, or the dashboard. No
  // step refuses to open because an earlier one is unfinished: a step that
  // needs an earlier answer says so where it matters.
  const onward = stepAfter(j, step.id);
  const next = onward?.url ?? "/";
  const skip = step.done ? undefined : next;
  const cont = (
    <Link href={next} className="btn btn-accent" style={primary}>
      Continue
    </Link>
  );

  switch (step.id) {
    case "business":
      return (
        <>
          <Heading step={step} title="Your account is ready." />
          <p style={lede}>
            {venue.name}, with prices in {venue.currency} and times in {venue.timezone}.
          </p>
          {cont}
        </>
      );

    case "import":
    case "review":
      return (
        <SetupWizard
          vertical={venue.vertical}
          currency={venue.currency}
          current={currentVenue(venue)}
          start={step.id === "review" ? "review" : "ask"}
          diary={onBellineDiary(venue)}
          lengthsRequired={serviceLengthsRequired(venue)}
          country={venueMarket(venue)}
        />
      );

    case "bookings":
      return (
        <>
          <Heading step={step} title="Where should bookings go?" />
          <p style={lede}>
            {venue.vertical === "clinic" && !flag("vertical.clinic.selfserve")
              ? "Clinics take booking requests only while clinics are in preview. You can change this later."
              : "You can change this later. Options that are not ready yet are shown as they are."}
          </p>
          <DestinationPicker
            options={destinationOptions(venue)}
            notice={googleNotice(google) ?? outlookNotice(outlook)}
            current={venue.onboarding?.destination?.kind}
            currentLink={venue.onboarding?.destination?.bookingLink}
            requested={venue.onboarding?.integrationRequests ?? []}
            partners={PARTNERS}
            skipHref={skip}
          />
        </>
      );

    case "rules": {
      const policies = venue.agent.policies;
      const requests = takesRequestsOnly(venue);
      const rules = requestRulesOf(venue);
      const o = venue.onboarding;
      return (
        <>
          <Heading step={step} title={requests ? "How Belline takes a request." : "Check the rules Belline follows."} />
          {!o?.destination && (
            <p className="panel" role="status" style={{ padding: "12px 14px", fontSize: 13.5, margin: "0 0 16px" }}>
              These rules follow from where bookings go, so choose that first. <Link href="/setup/bookings">Choose where bookings go</Link>
            </p>
          )}
          <p style={lede}>
            {requests
              ? "A few answers, and Belline follows them on every call and chat."
              : "Belline follows these on every call and chat. Change them first if anything is wrong."}
          </p>
          <RulesForm
            mode={destinationOf(venue) === "belline" ? "belline" : "requests"}
            restaurant={venue.vertical === "restaurant"}
            country={MARKETS[venueMarket(venue)].name}
            countryIso={venueMarket(venue)}
            initial={{
              askFor: rules.askFor.length > 0,
              transferNumber: o?.escalation?.transferNumber || venue.agent.transferNumber || venue.businessPhone,
              notify: o?.escalation?.notifyEmail || o?.escalation?.notifyWhatsApp || "",
              afterHours: rules.afterHours,
              neverSay: rules.neverSay.join("\n"),
            }}
            skipHref={skip}
          >
            {venue.vertical === "clinic" && (
              <div className="panel" style={{ padding: "14px 16px", margin: "22px 0 0" }}>
                <strong style={{ fontSize: 14 }}>Always on for clinics</strong>
                <p className="muted" style={{ margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.55 }}>
                  {CLINIC_MEDICAL_RULE}
                </p>
              </div>
            )}
            {!requests && (
              <div className="panel" style={{ padding: "14px 16px", margin: "22px 0 0" }}>
                {policies.length ? (
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.6 }}>
                    {policies.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
                    No rules yet. Belline will book within your hours and say it does not know anything it has not been told.
                  </p>
                )}
                <p className="muted" style={{ margin: "12px 0 0", fontSize: 13 }}>
                  You can change these later under Your business, in Agent.
                </p>
              </div>
            )}
          </RulesForm>
        </>
      );
    }

    case "website":
      return (
        <>
          <Heading step={step} title="Put Belline on your website." />
          <p style={lede}>
            A chat and voice button in the corner of your site. Choose what it offers and how it looks, name your website, and
            paste one line. This step is done once the button has loaded on your site. No website? Skip this and make a chat
            link on the next step instead.
          </p>
          {cont}
          <div style={{ marginTop: 22 }}>
            <WebsiteSection location={venue} />
          </div>
          <Footer step={step} skip={next}>
            {cont}
          </Footer>
        </>
      );

    case "phone": {
      const statuses = Object.fromEntries(channelStatuses(venue, facts, { whatsappConnected: whatsappLive }).map((c) => [c.id, c])) as Record<ChannelStatus["id"], ChannelStatus>;
      return (
        <>
          <Heading step={step} title="Let customers call and message Belline." />
          <p style={lede}>
            Any one of these is enough to go live, and so is the website chat. Your phone counts once a test call arrives, your
            chat link once you make it, and WhatsApp once it is connected. Nothing answers customers until you go live.
          </p>
          {cont}
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: "26px 0 10px" }}>Your phone line (optional)</h2>
          <PhoneSection location={venue} skipHref={next} />
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: "26px 0 10px" }}>A chat link, no website needed</h2>
          <LinkSection location={venue} live={statuses.link.state === "live"} />
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: "26px 0 10px" }}>WhatsApp</h2>
          <p className="muted" style={{ fontSize: 13.5, margin: "0 0 10px" }}>
            Optional. Going live does not wait for it.
          </p>
          <WhatsAppSection location={venue} skipHref={onward?.url} />
          <Footer step={step} skip={next}>
            {cont}
          </Footer>
        </>
      );
    }

    case "test": {
      const tests = venue.onboarding?.tests;
      return (
        <>
          <Heading step={step} title="Check it before your customers do." />
          <p style={lede}>
            Belline has eight conversations your customers really have, from a booking to a question it cannot answer, and
            checks every reply. It takes about a minute.
          </p>
          <SelftestPanel
            checks={SCENARIO_ORDER.map((id) => ({ id, title: scenarioTitle(id) }))}
            initial={tests?.results ?? null}
            stale={testsStale(venue)}
            available={selftestAvailable()}
            done={testsPassed(venue)}
            next={onward?.url ?? (j.activated ? "/" : null)}
            skipHref={skip}
          />
          <p className="muted" style={{ fontSize: 13, margin: "18px 0 0" }}>
            You can also <Link href="/channels">talk to it yourself</Link> under Channels, Try it.
          </p>
        </>
      );
    }

    case "golive": {
      const statuses = channelStatuses(venue, facts, { whatsappConnected: whatsappLive });
      if (j.activated) {
        return (
          <>
            <Heading step={step} title={`Belline is live for ${venue.name}.`} />
            <p style={lede}>Each channel answers once it is connected. One you connect later starts answering on its own.</p>
            {cont}
            <ChannelList statuses={statuses} />
            <Footer step={step} skip={next}>
              {cont}
            </Footer>
          </>
        );
      }
      const blocker = j.blockers[0];
      // Skip for now moves forward: to the dashboard, never back to an earlier step.
      const main = j.canGoLive ? (
        <ActionButton action="activate" label="Go live" />
      ) : (
        blocker && (
          <Link href={blocker.fix} className="btn btn-accent" style={primary}>
            Fix this
          </Link>
        )
      );
      return (
        <>
          <Heading step={step} title={j.canGoLive ? "Everything is ready." : "One thing before you go live."} />
          {j.canGoLive ? (
            <p style={lede}>
              Belline starts answering real customers for {venue.name} on the channels below that are connected. A channel you
              connect later starts answering on its own, without going live again.
            </p>
          ) : (
            blocker && <p style={lede}>{blocker.label}.</p>
          )}
          {j.canGoLive || !blocker ? (
            main
          ) : (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {main}
              <Link href={`/setup/assistant?step=${blocker.step}`} className="btn" style={{ padding: "12px 18px" }}>
                Ask Belle
              </Link>
            </div>
          )}
          <ChannelList statuses={statuses} />
          {/* The button again at the bottom, only when it is a link: two Go live
              buttons on one screen would be one too many to trust. */}
          <Footer step={step} skip={next}>
            {!j.canGoLive && main}
          </Footer>
        </>
      );
    }

    case "first-week":
      // Only true things. This step used to say "Belline is live" to a venue
      // that had never gone live, because it could be opened from the rail.
      if (!j.activated) {
        return (
          <>
            <Heading step={step} title="Your first week starts when you go live." />
            <p style={lede}>
              Belline is not live for {venue.name} yet, so no real customer has reached it. Once you go live, this step shows your
              first real enquiries.
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link href="/setup/golive" className="btn btn-accent" style={primary}>
                Go to Go live
              </Link>
              <Link href="/" className="btn" style={{ padding: "12px 18px" }}>
                Open the dashboard
              </Link>
            </div>
          </>
        );
      }
      return (
        <>
          <Heading step={step} title="Your first week." />
          <p style={lede}>
            {facts.enquiriesSinceLive > 0
              ? `${facts.enquiriesSinceLive === 1 ? "One real enquiry has" : `${facts.enquiriesSinceLive} real enquiries have`} come in since you went live.`
              : "Belline is live. Your first real enquiry will appear in your Inbox."}
          </p>
          <Link href="/" className="btn btn-accent" style={primary}>
            Open the dashboard
          </Link>
        </>
      );
  }
}

export default async function SetupStepPage({
  params,
  searchParams,
}: {
  params: Promise<{ step: string }>;
  searchParams: Promise<{ google?: string; outlook?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { step: requested } = await params;
  const { google, outlook } = await searchParams;

  const venue = listLocationsFor(user.tenantId)[0];
  if (!venue) redirect("/");
  if (RENAMED_STEPS[requested]) redirect(`/setup/${RENAMED_STEPS[requested]}`);
  if (!isStepId(requested)) redirect("/setup");

  // Only the steps that list channels pay for the WhatsApp lookup.
  const whatsappLive = requested === "phone" || requested === "golive" ? whatsappCard(venue, await whatsappStatus(venue)).state === "live" : false;
  const facts = factsFrom(venue, listCalls(venue.id));
  const j = journey(venue, facts);
  const step = j.steps.find((s) => s.id === requested)!;
  const tickets = ownerTickets(venue.id);
  // Steps whose main button belongs to a client component render their own
  // bottom row, with Skip for now in it. The import and review form keeps its
  // own sticky bar, so Skip for now sits under it here.
  const ownFooter = ["bookings", "rules", "website", "phone", "test", "golive", "first-week"].includes(step.id);

  return (
    <div className="has-belle-fab" style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <header
        style={{
          borderBottom: "1px solid var(--border)",
          background: "var(--panel)",
          padding: "14px 20px",
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <Brand size={22} />
        <span className="muted" style={{ fontSize: 12.5, marginLeft: "auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {venue.name}
        </span>
        {/* The dashboard is never behind setup. */}
        <Link href="/" className="btn" style={{ padding: "6px 12px", fontSize: 13, flexShrink: 0 }} data-testid="setup-dashboard">
          Dashboard
        </Link>
        {/* No "Ask Belle" here: the floating bell (BelleDock) is the one way in. */}
      </header>

      {/* Not while Belline staff view this as the customer: that view is read-only, and Belle saves. */}
      <BelleDock locationId={venue.id} step={step.id} greeting={setupGreeting(venue, step.id)} off={await onViewAs()} faceUrl={belleFaceUrl()} video={supportVideoOn()}>
        <div className="setup-grid" style={{ maxWidth: 1000, margin: "0 auto", padding: "28px 20px 112px" }}>
          <Rail j={j} active={step} />
          <main style={{ minWidth: 0, maxWidth: 720 }}>
            <Body step={step} j={j} venue={venue} facts={facts} google={google} outlook={outlook} whatsappLive={whatsappLive} />
            {/* Every unfinished step can be left for later. */}
            {!ownFooter && (
              <Footer step={step} skip={stepAfter(j, step.id)?.url ?? "/"}>
                {step.id === "business" && (
                  <Link href={stepAfter(j, step.id)?.url ?? "/"} className="btn btn-accent" style={primary}>
                    Continue
                  </Link>
                )}
              </Footer>
            )}
            {/* A ticket the team is working on, so the owner is not left guessing. */}
            {tickets.map((t) => (
              <div key={t.ticket} className="panel" role="status" style={{ padding: "12px 16px", marginTop: 22, fontSize: 13.5 }}>
                <strong>Ticket {t.ticket}</strong> · {t.status}. We will contact you at the email address on your account.
              </div>
            ))}
          </main>
        </div>
      </BelleDock>
    </div>
  );
}
