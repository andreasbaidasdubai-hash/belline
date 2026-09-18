import { notFound } from "next/navigation";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { signVisitorToken } from "@/lib/auth";
import { originAllowed } from "@/lib/embed";
import { chatAllowed, newVisitorId, voiceAllowed } from "@/lib/webchat";
import { widgetOpenFor } from "@/lib/embed-preview";
import { isActivated } from "@/lib/onboarding/journey";
import { lineFor } from "@/lib/language";
import { videoAvailability, videoBubbleConfig, venueFaceId } from "@/lib/video/availability";
import { deliveredCeiling } from "@/lib/video/delivery";
import { facePreview } from "@/lib/video/face-preview";
import { venueByEmbedKey } from "@/lib/video/http";
import VideoPanel from "./VideoPanel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Video call",
  robots: { index: false, follow: false },
};

/**
 * The video receptionist, inside a venue's own website.
 *
 * The same checks as the bell and the chat, in the same order — the key names a
 * venue with the widget on, the page framing us is one the venue named — plus
 * video's own (lib/video/availability.ts). Passing them mints the visitor's
 * signed identity and nothing more: no session exists until the visitor has
 * read what happens next and pressed Start.
 *
 * A venue that is not offering video right now gets a readable page with the
 * chat and the bell, never a blank frame. The reason is for staff and stays in
 * the sales console.
 */
export default async function VideoPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ o?: string; autostart?: string; bubble?: string }>;
}) {
  const { key } = await params;
  const { o, autostart, bubble } = await searchParams;
  const location = venueByEmbedKey(key);
  if (!location?.embed) notFound();

  if (!(await widgetOpenFor(location))) {
    return <Unavailable reason={lineFor(location, "embed.not_switched_on", { name: location.name })} />;
  }

  const head = await headers();
  const framedBy = head.get("origin") ?? refererOrigin(head.get("referer"));
  if (!originAllowed(location.embed, framedBy)) {
    return <Unavailable reason={lineFor(location, "embed.wrong_site")} />;
  }

  const origin = o ? `?o=${encodeURIComponent(o)}` : "";
  const chatHref = chatAllowed(location.embed) ? `/embed/${encodeURIComponent(key)}/chat${origin}` : undefined;
  // Belline's own site has no bell in its widget; its spoken demo is /call.
  const voiceHref = voiceAllowed(location.embed)
    ? `/embed/${encodeURIComponent(key)}${origin}`
    : location.internal
      ? "/call?start=1"
      : undefined;

  const availability = videoAvailability(location, { skipLive: !isActivated(location) });
  if (!availability.on) {
    return (
      <Unavailable
        reason="Video calls aren't available right now."
        chatHref={chatHref}
        voiceHref={voiceHref}
      />
    );
  }

  // On a page of its own the face's muted preview plays in the circle while the
  // call connects, as it does in the bubble on a website (where the page's own
  // circle shows it under this frame, so none is needed here).
  let preview = { clipUrl: "", posterUrl: "" };
  if (bubble !== "1") {
    const own = videoBubbleConfig(location);
    preview = { clipUrl: own.clipUrl, posterUrl: own.posterUrl };
    if (!own.mock && (!own.clipUrl || !own.posterUrl)) {
      const face = await facePreview(availability.config, undefined, undefined, venueFaceId(location, availability.config));
      if (face) preview = { clipUrl: own.clipUrl || face.clipUrl, posterUrl: own.posterUrl || face.posterUrl };
    }
  }

  return (
    <VideoPanel
      previewClipUrl={preview.clipUrl}
      previewPosterUrl={preview.posterUrl}
      embedKey={key}
      freshToken={signVisitorToken(location.id, newVisitorId())}
      venueName={location.name}
      agentName={location.agent.displayName}
      provider={availability.config.provider}
      maxCallSeconds={availability.config.maxCallSeconds}
      // What calls here really run to, not what we ask the provider for.
      promisedSeconds={deliveredCeiling(availability.config.maxCallSeconds).seconds}
      chatHref={chatHref}
      voiceHref={voiceHref}
      // From the greeting bubble: the visitor already tapped to talk.
      autostart={autostart === "1"}
      // Inside the page's own bubble: chromeless, and it talks only to the origin checked above.
      bubble={bubble === "1" && Boolean(framedBy)}
      hostOrigin={bubble === "1" && framedBy ? framedBy : undefined}
    />
  );
}

function refererOrigin(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function Unavailable({ reason, chatHref, voiceHref }: { reason: string; chatHref?: string; voiceHref?: string }) {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        alignContent: "center",
        gap: 16,
        padding: 28,
        textAlign: "center",
        background: "var(--bl-ground)",
        color: "var(--bl-ink-900)",
        fontFamily: "var(--bl-font-text)",
      }}
    >
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, maxWidth: "34ch" }}>{reason}</p>
      {(chatHref || voiceHref) && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
          {chatHref && (
            <a
              href={chatHref}
              style={{
                padding: "11px 18px",
                borderRadius: "var(--bl-radius-pill)",
                background: "var(--bl-blue)",
                color: "var(--bl-white)",
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              Chat instead
            </a>
          )}
          {voiceHref && (
            <a
              href={voiceHref}
              style={{
                padding: "11px 18px",
                borderRadius: "var(--bl-radius-pill)",
                border: "1px solid var(--bl-rule-strong)",
                color: "var(--bl-ink-900)",
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              Talk by voice
            </a>
          )}
        </div>
      )}
    </main>
  );
}
