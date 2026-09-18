import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth-server";
import { signVisitorToken } from "@/lib/auth";
import { bellineVenue, dashboardBelleVenue } from "@/lib/belle/identity";
import { onViewAs } from "@/lib/belle/server";
import { listLocationsFor } from "@/lib/store";
import { videoAvailability, videoBubbleConfig } from "@/lib/video/availability";
import { deliveredCeiling } from "@/lib/video/delivery";
import BelleVideoFrame from "./BelleVideoFrame";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Talk to Belle on video",
  robots: { index: false, follow: false },
};

/**
 * "Talk to Belle on video", opened inside Ask Belle in the dashboard. Under
 * /embed so the middleware lets our own pages frame it (frame-ancestors 'self').
 *
 * The owner reads what happens and presses Start: that press, and only that,
 * creates a session (/api/belle/video/session). Belline's own video persona on
 * Belline's own venue, briefed with this owner's account, and paid from
 * Belline's support budget (VIDEO_SUPPORT_MAX_SESSIONS_PER_DAY). Not on a
 * read-only view-as session, and not for anyone Ask Belle is not offered to.
 */
export default async function BelleVideoPage() {
  const user = await requireUser();
  if (await onViewAs()) notFound();
  const own = dashboardBelleVenue(user, listLocationsFor(user.tenantId), null);
  const venue = bellineVenue();
  if (!own || !venue) notFound();

  const availability = videoAvailability(venue, { kind: "support" });
  if (!availability.on) {
    return (
      <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>
        <p style={{ margin: 0, maxWidth: "34ch", lineHeight: 1.6 }}>Video with Belle isn&apos;t available right now. You can keep chatting with her in Ask Belle.</p>
      </main>
    );
  }
  const face = videoBubbleConfig(venue);

  return (
    <BelleVideoFrame
      embedKey="be_belline_site"
      apiBase="/api/belle/video"
      freshToken={signVisitorToken(venue.id, `owner_${user.id}`)}
      venueName="Belline"
      agentName="Belle"
      provider={availability.config.provider}
      maxCallSeconds={availability.config.maxCallSeconds}
      promisedSeconds={deliveredCeiling(availability.config.maxCallSeconds).seconds}
      previewClipUrl={face.clipUrl}
      previewPosterUrl={face.posterUrl}
      introTitle="Talk to Belle on video"
      introBody="Belle is Belline's AI assistant. She can see your account and help with setup, your plan or anything about Belline. When you press Start, your browser will ask to use your microphone so she can hear you. Your camera stays off and the call isn't recorded."
      startLabel="Start"
    />
  );
}
