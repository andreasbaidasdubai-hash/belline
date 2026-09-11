import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findProspect } from "@/lib/prospect";
import { signStreamToken } from "@/lib/auth";
import Console from "../../(app)/test/Console";
import { findRecordedDemo, RecordedDemoPage } from "./Recorded";

export const dynamic = "force-dynamic";

/**
 * A prospect's personalised demo.
 *
 * Deliberately public — the whole point is that it can be sent in an email
 * and opened by someone who has never heard of us. Which is exactly why it
 * states, three times and without being asked, that it was assembled from a
 * public web page and is not the business's real phone line.
 *
 * Not indexable. A page carrying somebody else's trading name should not turn
 * up when their patients search for them.
 */

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function ProspectDemoPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // Two kinds of demo share this path, because a prospect should never have to
  // learn which one they were sent.
  //
  //   A *recording* — a 30-60 second simulated call, generated from their
  //   website and emailed as a link. Built by the sales engine.
  //
  //   A *live venue* — a callable Belline configured as their business, built
  //   by `createProspectDemo` from a pasted URL.
  //
  // Recordings are checked first: they are what the outbound funnel sends, and
  // a live venue is only ever reached by a slug a person made by hand.
  const recording = await findRecordedDemo(slug);
  if (recording) return <RecordedDemoPage demo={recording} />;

  const location = findProspect(slug);
  if (!location) notFound();

  // Short-lived, and it names the venue — so the browser never gets to say
  // which business it would like to spend a call on.
  const token = signStreamToken(location.id, 60 * 60);
  const expires = new Date(location.prospect!.expiresAt);

  return (
    <div className="prospect">
      <header className="prospect-top">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.svg" alt="Belline" />
        <span className="prospect-badge">Demonstration</span>
      </header>

      <main className="prospect-main">
        <p className="prospect-eyebrow">{location.name} × Belline</p>
        <h1>This is what your phone could sound like.</h1>
        <p className="prospect-lead">
          We read your website and gave Belline your name, your services and
          your hours — about two minutes of work. Press the button, speak as
          one of your own callers would, and see how far it gets.
        </p>

        <div className="prospect-note">
          <strong>Nothing here is real.</strong> This was assembled
          automatically from{" "}
          <a href={location.prospect!.sourceUrl} rel="nofollow noopener noreferrer" target="_blank">
            your public website
          </a>
          , so some of it will be wrong. It is not connected to your phone line,
          your diary or your patients, and nothing booked here exists. The page
          disappears on {expires.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}.
        </div>

        <div className="prospect-call">
          <Console
            locationId={location.id}
            locationName={location.name}
            demoToken={token}
            compact
          />
        </div>

        <section className="prospect-try">
          <h2>Things worth trying</h2>
          <ul>
            <li>Book something, then ring back and move it.</li>
            <li>Ask for a time you are closed, and see what it offers instead.</li>
            <li>Ask a question your website does not answer.</li>
            <li>
              {location.vertical === "restaurant"
                ? "Ask for a table for twenty-five."
                : "Ask it something medical, and watch it refuse."}
            </li>
          </ul>
        </section>

        <section className="prospect-cta">
          <h2>Want the real one?</h2>
          <p>
            The version you just spoke to knows what a web page could tell it.
            The real one knows your diary, your staff and your rules — and it
            answers your actual number.
          </p>
          <a className="prospect-btn" href="mailto:hello@belline.ai?subject=Belline%20for%20my%20business">
            Book fifteen minutes
          </a>
        </section>
      </main>

      <footer className="prospect-foot">
        Belline · AI reception · This demonstration is unaffiliated with and
        unverified by {location.name}.
      </footer>
    </div>
  );
}
