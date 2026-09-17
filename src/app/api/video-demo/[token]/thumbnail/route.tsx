import { ImageResponse } from "next/og";
import { videoBubbleConfig, venueFaceId } from "@/lib/video/availability";
import { videoConfig } from "@/lib/video/config";
import { facePreview } from "@/lib/video/face-preview";
import { bellineVenue } from "@/lib/sales/video-demo/http";
import { resolveDemoToken } from "@/lib/sales/video-demo/service";
import { posterDataUri } from "@/lib/sales/video-demo/thumbnail";

export const dynamic = "force-dynamic";

const BLUE = "#0071e3";

/**
 * The picture in the email: Belle's face in a circle with a play button, and
 * who the demo is for. Email clients cannot play video, so the email carries
 * this and links to the page.
 *
 * The face is the venue face's real poster (Tavus `thumbnail_image_url`, or a
 * deployment poster), read server-side and embedded in the PNG; without one,
 * a clean Belline-blue circle. Drawn on request from the link, so a revoked or
 * expired link's image stops naming the business and a mail client that
 * fetches it later never breaks.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const resolved = await resolveDemoToken(token);
  const name = resolved.ok ? resolved.link.facts.businessName : null;

  const poster = await posterFor();
  const size = 380;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          padding: "0 72px",
          background: "linear-gradient(135deg, #fbfbfd 0%, #eaf1fc 100%)",
          color: "#1d1d1f",
        }}
      >
        <div
          style={{
            position: "relative",
            width: size,
            height: size,
            borderRadius: size / 2,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: `linear-gradient(160deg, #2997ff 0%, ${BLUE} 55%, #0058b0 100%)`,
            boxShadow: "0 28px 60px rgba(0, 40, 90, 0.22)",
            border: "6px solid #ffffff",
            flexShrink: 0,
          }}
        >
          {poster && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={poster} width={size} height={size} style={{ position: "absolute", top: 0, left: 0, width: size, height: size, objectFit: "cover", objectPosition: "46% 50%" }} alt="" />
          )}
          {/* A soft shade under the button, so white reads on any poster. */}
          <div style={{ position: "absolute", width: 170, height: 170, borderRadius: 85, background: "rgba(0,0,0,0.16)", display: "flex" }} />
          <div
            style={{
              position: "absolute",
              width: 128,
              height: 128,
              borderRadius: 64,
              background: "#ffffff",
              boxShadow: "0 10px 28px rgba(0,0,0,0.25)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="56" height="56" viewBox="0 0 24 24" style={{ marginLeft: 8 }}>
              <path d="M7 4.5v15a1 1 0 0 0 1.52.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5Z" fill={BLUE} />
            </svg>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginLeft: 64, maxWidth: 600 }}>
          <div style={{ display: "flex", fontSize: 32, color: "#6e6e73", marginBottom: 12 }}>
            {name ? "A 2-minute personal demo for" : "A personal demo from Belline"}
          </div>
          <div style={{ display: "flex", fontSize: name && name.length > 26 ? 54 : 66, fontWeight: 700, lineHeight: 1.06, letterSpacing: -1 }}>
            {name ?? "Meet Belle"}
          </div>
          <div style={{ display: "flex", marginTop: 34 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "12px 24px 12px 14px",
                borderRadius: 999,
                background: BLUE,
                color: "#ffffff",
                fontSize: 27,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: 17, background: "#ffffff", marginRight: 14 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" style={{ marginLeft: 3 }}>
                  <path d="M7 4.5v15a1 1 0 0 0 1.52.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5Z" fill={BLUE} />
                </svg>
              </div>
              Watch · Belle, Belline&apos;s AI receptionist
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 675,
      headers: { "cache-control": resolved.ok ? "public, max-age=3600" : "public, max-age=600" },
    },
  );
}

/** Belle's still: the venue's own poster, else the venue face's Tavus thumbnail. Null draws the blue circle. */
async function posterFor(): Promise<string | null> {
  try {
    const venue = bellineVenue();
    if (!venue) return null;
    const own = videoBubbleConfig(venue);
    let url = own.posterUrl;
    if (!url && !own.mock) {
      // Whether or not video is on right now: the email keeps its picture.
      const config = videoConfig();
      url = (await facePreview(config, undefined, undefined, venueFaceId(venue, config)))?.posterUrl ?? "";
    }
    return url ? await posterDataUri(url) : null;
  } catch {
    return null;
  }
}
