import Link from "next/link";
import { redirect } from "next/navigation";
import Brand from "@/components/Brand";
import { requireUser } from "@/lib/auth-server";
import { listCalls, listLocationsFor } from "@/lib/store";
import { currentVenue } from "@/lib/onboarding";
import { factsFrom, isStepId, journey, type Journey, type Step } from "@/lib/onboarding/journey";
import { flag } from "@/lib/flags";
import { seedIfEmpty } from "@/lib/seed";
import type { Location } from "@/lib/types";
import SetupWizard from "../SetupWizard";
import { ActionButton, DestinationPicker, type DestinationOption } from "../StepActions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Set up Belline" };

/**
 * One setup, one step at a time.
 *
 * Outside the `(app)` group on purpose: somebody who signed up ninety seconds
 * ago has one job, and a sidebar of dashboard links is a list of ways not to
 * do it. Every step has one primary button, placed before any detail so it is
 * on screen on a phone without scrolling. Steps that need an editor that
 * already exists link out to it with ?from=setup, and that page shows the way
 * back.
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

function Card({ title, status, children }: { title: string; status: string; children: React.ReactNode }) {
  return (
    <div className="panel" style={{ padding: "14px 16px", marginTop: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14.5 }}>{title}</strong>
        <span className="pill" style={{ marginLeft: "auto" }}>
          {status}
        </span>
      </div>
      <div className="muted" style={{ fontSize: 13, lineHeight: 1.55, marginTop: 6 }}>
        {children}
      </div>
    </div>
  );
}

function Rail({ j, active }: { j: Journey; active: Step }) {
  const reachable = (s: Step) => s.done || s.id === j.next?.id || s.n <= (j.next?.n ?? Infinity);
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
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
          {j.steps.map((s) => {
            const label = (
              <>
                <span aria-hidden="true" style={{ width: 20, display: "inline-block", color: s.done ? "var(--ok)" : "var(--text-2)" }}>
                  {s.done ? "✓" : s.n}
                </span>
                {s.title}
                {s.done && <span className="sr-only"> (done)</span>}
              </>
            );
            const style = {
              display: "block",
              padding: "7px 10px",
              borderRadius: 8,
              fontSize: 13.5,
              background: s.id === active.id ? "var(--panel-2)" : "transparent",
              fontWeight: s.id === active.id ? 600 : 400,
              color: reachable(s) ? "var(--text)" : "var(--text-2)",
            } as const;
            return (
              <li key={s.id}>
                {reachable(s) ? (
                  <Link href={s.url} aria-current={s.id === active.id ? "step" : undefined} style={style}>
                    {label}
                  </Link>
                ) : (
                  <span style={style}>{label}</span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <p className="setup-rail-compact muted" style={{ fontSize: 12.5, margin: "0 0 18px" }}>
        Step {active.n} of {j.steps.length} · {j.steps.filter((s) => s.done).length} done
      </p>
    </>
  );
}

function destinationOptions(): DestinationOption[] {
  const calendar = (on: boolean): DestinationOption["state"] => (on ? "preparing" : "soon");
  return [
    {
      kind: "belline",
      title: "Belline's diary",
      body: "Belline books straight into the calendar in your dashboard, and your team sees every booking there.",
      state: "available",
    },
    {
      kind: "requests",
      title: "Take requests, and confirm them yourself",
      body: "Belline takes the details and your team confirms each booking.",
      state: "preparing",
    },
    {
      kind: "google",
      title: "Google Calendar",
      body: "Belline checks when you are free and books into your own calendar.",
      state: calendar(flag("booking.google")),
    },
    {
      kind: "outlook",
      title: "Outlook calendar",
      body: "The same, for a Microsoft 365 calendar.",
      state: calendar(flag("booking.outlook")),
    },
  ];
}

function Body({ step, j, venue, facts }: { step: Step; j: Journey; venue: Location; facts: ReturnType<typeof factsFrom> }) {
  const next = j.next;
  const onward = next && next.id !== step.id ? next : null;
  const cont = (
    <Link href={onward?.url ?? "/"} className="btn btn-accent" style={primary}>
      Continue
    </Link>
  );

  // A step further on than the one the owner has reached shows the way back to
  // it, not a button that would do something out of order. Reading and
  // reviewing stay open: they are how an earlier answer gets changed.
  if (next && step.n > next.n && step.id !== "golive" && !step.done) {
    return (
      <>
        <Heading step={step} title={`Finish "${next.title}" first.`} />
        <p style={lede}>Each step uses what the one before it saved.</p>
        <Link href={next.url} className="btn btn-accent" style={primary}>
          Go to {next.title.toLowerCase()}
        </Link>
      </>
    );
  }

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
        <SetupWizard vertical={venue.vertical} currency={venue.currency} current={currentVenue(venue)} start={step.id === "review" ? "review" : "ask"} />
      );

    case "bookings":
      return (
        <>
          <Heading step={step} title="Where should bookings go?" />
          <p style={lede}>You can change this later. Options that are not ready yet are shown as they are.</p>
          <DestinationPicker options={destinationOptions()} current={venue.onboarding?.destination?.kind} />
        </>
      );

    case "rules": {
      const policies = venue.agent.policies;
      return (
        <>
          <Heading step={step} title="Check the rules Belline follows." />
          <p style={lede}>Belline follows these on every call and chat. Change them first if anything is wrong.</p>
          <ActionButton action="rules" label="Confirm these rules" />
          <div className="panel" style={{ padding: "14px 16px", marginTop: 22 }}>
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
            <p style={{ margin: "12px 0 0", fontSize: 13 }}>
              <Link href="/agents?from=setup">Change the rules</Link>
            </p>
          </div>
        </>
      );
    }

    case "channels":
      return (
        <>
          <Heading step={step} title="Let calls and chats reach Belline." />
          <p style={lede}>
            One is enough to go live. This step is marked done when the first forwarded call or website conversation
            arrives.
          </p>
          {step.done ? (
            cont
          ) : (
            <Link href="/golive?from=setup" className="btn btn-accent" style={primary}>
              Set up call forwarding
            </Link>
          )}
          <Card title="Your phone line" status={facts.phoneCalls > 0 ? "Working" : venue.phone ? "Waiting for a call" : "Number being prepared"}>
            {facts.phoneCalls > 0
              ? "Forwarded calls are reaching Belline."
              : venue.phone
                ? `Forward the calls you miss to ${venue.phone}, then ring your own number from another phone.`
                : "Your Belline number is being prepared. It appears on the forwarding page as soon as it is ready."}
          </Card>
          <Card title="Your website" status={facts.webConversations > 0 ? "Working" : "Not added yet"}>
            {facts.webConversations > 0 ? (
              "Website visitors are talking to Belline."
            ) : (
              <>
                Add the chat to your site with one line of code. <Link href="/website?from=setup">Add it to my website</Link>
              </>
            )}
          </Card>
        </>
      );

    case "test":
      return (
        <>
          <Heading step={step} title="Talk to it before your customers do." />
          <p style={lede}>
            Ask for a booking and a question you get every day. Automatic checks are being prepared; until they are
            ready, one conversation of your own in the test console completes this step.
          </p>
          {step.done ? (
            cont
          ) : (
            <Link href="/test?from=setup" className="btn btn-accent" style={primary}>
              Talk to it
            </Link>
          )}
        </>
      );

    case "golive": {
      if (j.activated) {
        return (
          <>
            <Heading step={step} title={`Belline is answering for ${venue.name}.`} />
            {cont}
          </>
        );
      }
      const blocker = j.blockers[0];
      return (
        <>
          <Heading step={step} title={j.canGoLive ? "Everything is ready." : "One thing before you go live."} />
          {j.canGoLive ? (
            <>
              <p style={lede}>Belline starts answering real calls and chats for {venue.name}. You can pause it at any time.</p>
              <ActionButton action="activate" label="Go live" />
            </>
          ) : (
            blocker && (
              <>
                <p style={lede}>{blocker.label}.</p>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <Link href={blocker.fix} className="btn btn-accent" style={primary}>
                    Fix this
                  </Link>
                  <Link href="/setup/assistant" className="btn" style={{ padding: "12px 18px" }}>
                    Ask Belle
                  </Link>
                </div>
              </>
            )
          )}
        </>
      );
    }

    case "first-week":
      return (
        <>
          <Heading step={step} title="Your first week." />
          <p style={lede}>
            {facts.enquiriesSinceLive > 0
              ? `${facts.enquiriesSinceLive === 1 ? "One real enquiry has" : `${facts.enquiriesSinceLive} real enquiries have`} come in so far.`
              : "Belline is live. Your first real enquiry will appear on the dashboard."}
          </p>
          <Link href="/" className="btn btn-accent" style={primary}>
            Open the dashboard
          </Link>
        </>
      );
  }
}

export default async function SetupStepPage({ params }: { params: Promise<{ step: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  const { step: requested } = await params;

  const venue = listLocationsFor(user.tenantId)[0];
  if (!venue) redirect("/");
  if (!isStepId(requested)) redirect("/setup");

  const facts = factsFrom(venue, listCalls(venue.id));
  const j = journey(venue, facts);
  const step = j.steps.find((s) => s.id === requested)!;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
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
        <Link href="/setup/assistant" style={{ fontSize: 12.5, flex: "none" }}>
          Ask Belle
        </Link>
      </header>

      <div className="setup-grid" style={{ maxWidth: 1000, margin: "0 auto", padding: "28px 20px 90px" }}>
        <Rail j={j} active={step} />
        <main style={{ minWidth: 0, maxWidth: 720 }}>
          <Body step={step} j={j} venue={venue} facts={facts} />
        </main>
      </div>
    </div>
  );
}
