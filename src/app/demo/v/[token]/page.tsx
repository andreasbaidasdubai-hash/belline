import type { Metadata } from "next";
import { signVisitorToken } from "@/lib/auth";
import { newVisitorId } from "@/lib/webchat";
import { isActivated } from "@/lib/onboarding/journey";
import { videoAvailability, videoBubbleConfig, venueFaceId } from "@/lib/video/availability";
import { videoConfig } from "@/lib/video/config";
import { facePreview } from "@/lib/video/face-preview";
import { bellineVenue } from "@/lib/sales/video-demo/http";
import { pageViewAllowed, resolveDemoToken } from "@/lib/sales/video-demo/service";
import { demoPackages } from "@/lib/sales/video-demo/packages";
import { videoLive } from "@/lib/billing/plans";
import { siteOrigin } from "@/lib/origin";
import { SETUP_CLAIM } from "@/lib/seed-belline";
import DemoExperience from "./DemoExperience";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your personal Belline demo",
  robots: { index: false, follow: false },
  // The token is the URL: it must not travel to anywhere this page links.
  referrer: "no-referrer",
};

/**
 * A prospect's personalised video demo, from the link in their email.
 *
 * Rendering this page spends nothing: no session, no model call, no provider
 * request beyond the face's cached preview. The call starts only when the
 * visitor taps "Tap to meet Belle", and "opened" is reported by the page's
 * script, not by this request (mail scanners fetch links nobody clicked).
 */
export default async function VideoDemoPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = await resolveDemoToken(token);
  if (!resolved.ok) {
    return (
      <Notice
        title={resolved.reason === "expired" ? "This demo link has expired" : "This demo link isn't available"}
        body="Personal demo links only work for a while. You can still talk to Belle, Belline's AI receptionist, on our website."
      />
    );
  }
  if (!pageViewAllowed(resolved.link.id)) {
    return <Notice title="One moment" body="This page has been opened a lot in the last minute. Please try again shortly." />;
  }
  const venue = bellineVenue();
  if (!venue) return <Notice title="Belle is unavailable" body="Please try again in a few minutes." />;

  const { link } = resolved;
  const availability = videoAvailability(venue, { skipLive: !isActivated(venue) });
  const config = availability.on ? availability.config : videoConfig();
  const own = videoBubbleConfig(venue);
  let preview = { clipUrl: own.clipUrl, posterUrl: own.posterUrl };
  if (availability.on && !own.mock && (!own.clipUrl || !own.posterUrl)) {
    const face = await facePreview(availability.config, undefined, undefined, venueFaceId(venue, availability.config));
    if (face) preview = { clipUrl: own.clipUrl || face.clipUrl, posterUrl: own.posterUrl || face.posterUrl };
  }

  // Belle's own prepared answers, word for word, so the page and Belle agree.
  const faqs = FAQ_QUESTIONS.map((q) => venue.agent.faqs.find((f) => f.q === q)).filter((f): f is { q: string; a: string } => Boolean(f));

  return (
    <DemoExperience
      token={resolved.token}
      businessName={link.facts.businessName}
      firstName={link.facts.firstName}
      opening={link.opening}
      visitorToken={signVisitorToken(venue.id, newVisitorId())}
      videoOn={availability.on}
      videoLive={videoLive()}
      provider={config.provider}
      maxCallSeconds={config.maxCallSeconds}
      previewClipUrl={preview.clipUrl}
      previewPosterUrl={preview.posterUrl}
      siteOrigin={siteOrigin()}
      packages={demoPackages("AE")}
      setupClaim={SETUP_CLAIM}
      faqs={faqs}
    />
  );
}

/** Three questions a prospect has after the call, answered in Belle's own prepared words (seed-belline.ts). */
const FAQ_QUESTIONS = ["How long does it take to set up?", "Do we have to change our phone number?", "Can it transfer a call to a person?"];

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        alignContent: "center",
        gap: 14,
        padding: "32px 20px",
        textAlign: "center",
        background: "var(--bl-surface)",
        color: "var(--bl-ink-900)",
        fontFamily: "var(--bl-font-text)",
      }}
    >
      <h1 style={{ margin: 0, fontFamily: "var(--bl-font-display)", fontWeight: 600, fontSize: 28, letterSpacing: "-0.01em" }}>{title}</h1>
      <p style={{ margin: 0, fontSize: 17, lineHeight: 1.47, color: "var(--bl-text-2)", maxWidth: "36ch" }}>{body}</p>
      <a
        href="https://belline.ai"
        rel="noreferrer"
        style={{ marginTop: 6, padding: "12px 22px", borderRadius: 999, background: "var(--bl-blue)", color: "#fff", textDecoration: "none", fontSize: 17 }}
      >
        Visit belline.ai
      </a>
    </main>
  );
}
