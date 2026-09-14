import type { Metadata } from "next";
import { headers } from "next/headers";
import Brand from "@/components/Brand";
import { notFound } from "next/navigation";
import { ensureDemoWidget, findProspect } from "@/lib/prospect";
import { signStreamToken } from "@/lib/auth";
import { TRIAL } from "@/lib/billing/plans";
import Console from "../../(app)/test/Console";
import { findRecordedDemo, RecordedDemoPage } from "./Recorded";

export const dynamic = "force-dynamic";

/**
 * A prospect's personalised demo: their own receptionist, to type to or talk to.
 *
 * Deliberately public — the whole point is that it can be sent in an email
 * and opened by someone who has never heard of us. Which is exactly why it
 * states plainly, without being asked, that it was assembled from a public
 * web page and is not the business's real line or diary.
 *
 * The chat is the real website widget framed from our own origin, and the
 * voice console is the real call — so what the prospect tries is the product
 * they would install, not a recording of it.
 *
 * Not indexable. A page carrying somebody else's trading name should not turn
 * up when their customers search for them.
 */

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

async function requestOrigin(): Promise<string> {
  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "app.belline.ai";
  const proto = head.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto.split(",")[0]}://${host.split(",")[0]}`;
}

export default async function ProspectDemoPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // Two kinds of demo share this path, because a prospect should never have to
  // learn which one they were sent: a *recording* made by the sales engine,
  // and a *live venue* built by `createProspectDemo`. Recordings first.
  const recording = await findRecordedDemo(slug);
  if (recording) return <RecordedDemoPage demo={recording} />;

  const found = findProspect(slug);
  if (!found) notFound();

  const origin = await requestOrigin();
  const location = ensureDemoWidget(found, origin);

  // Short-lived, and it names the venue — so the browser never gets to say
  // which business it would like to spend a call on.
  const token = signStreamToken(location.id, 60 * 60);
  const expires = new Date(location.prospect!.expiresAt);
  const chatSrc = `/embed/${encodeURIComponent(location.embed!.key)}/chat?o=${encodeURIComponent(origin)}`;
  const trialHref = `/checkout?products=everything_business`;

  return (
    <div className="prospect prospect-wide">
      <header className="prospect-top">
        <Brand size={22} />
        <span className="prospect-badge">Your demo</span>
      </header>

      <main className="prospect-main">
        <p className="prospect-eyebrow">{location.name} × Belline</p>
        <h1>Meet your new receptionist.</h1>
        <p className="prospect-lead">
          We read your website and set Belline up as {location.name} — your name,
          your services, your hours. Type to it like a customer on your website, or
          press the button and call it. Try to catch it out.
        </p>

        <div className="prospect-note">
          <strong>This is a demo.</strong> It was built automatically from{" "}
          <a href={location.prospect!.sourceUrl} rel="nofollow noopener noreferrer" target="_blank">
            your public website
          </a>
          , so some details may be off. It is not connected to your phone line or your
          diary, and nothing booked here is real. The page disappears on{" "}
          {expires.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}.
        </div>

        <div className="prospect-grid">
          <section className="prospect-pane">
            <h2>Chat, as on your website</h2>
            <iframe className="prospect-chat" src={chatSrc} title={`Chat with ${location.name}`} allow="microphone" />
          </section>
          <section className="prospect-pane">
            <h2>Call it</h2>
            <div className="prospect-call">
              <Console locationId={location.id} locationName={location.name} demoToken={token} compact />
            </div>
            <div className="prospect-try">
              <h2>Things worth trying</h2>
              <ul>
                <li>Book something, then ask to move it.</li>
                <li>Ask for a time you are closed, and see what it offers instead.</li>
                <li>Ask a question your website does not answer.</li>
                <li>
                  {location.vertical === "restaurant"
                    ? "Ask for a table for twenty-five."
                    : "Ask it something medical, and watch it refuse."}
                </li>
              </ul>
            </div>
          </section>
        </div>

        <section className="prospect-cta">
          <h2>Want this answering your real phone and website?</h2>
          <p>
            The real one knows your diary, your staff and your rules, answers your own
            number, and books straight into your calendar. Setup takes minutes: paste your
            website and Belline does the rest.
          </p>
          <div className="prospect-actions">
            <a className="prospect-btn" href={trialHref}>
              Start {TRIAL.days} days free — no card
            </a>
            <a className="prospect-btn prospect-btn-line" href="mailto:hello@belline.ai?subject=Belline%20for%20my%20business">
              Talk to a person
            </a>
          </div>
        </section>
      </main>

      <footer className="prospect-foot">
        Belline · AI reception · This demonstration is unaffiliated with and unverified by{" "}
        {location.name}.
      </footer>
    </div>
  );
}
