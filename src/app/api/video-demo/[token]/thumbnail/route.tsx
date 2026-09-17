import { ImageResponse } from "next/og";
import { videoBubbleConfig } from "@/lib/video/availability";
import { bellineVenue } from "@/lib/sales/video-demo/http";
import { resolveDemoToken } from "@/lib/sales/video-demo/service";

export const dynamic = "force-dynamic";

/**
 * The picture in the email: Belle's poster in a circle, a play button, and the
 * business's name. Email clients cannot play video, so the email carries this
 * and links to the page.
 *
 * Drawn on request from the link, so a revoked or expired link's image stops
 * naming the business (it falls back to a plain Belline card) and a mail
 * client that fetches it later never breaks.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const resolved = await resolveDemoToken(token);
  const name = resolved.ok ? resolved.link.facts.businessName : null;
  const origin = new URL(req.url).origin;

  const venue = bellineVenue();
  const poster = venue ? videoBubbleConfig(venue).posterUrl : "";
  const posterUrl = poster ? (poster.startsWith("/") ? `${origin}${poster}` : poster) : "";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          padding: "0 64px",
          background: "linear-gradient(135deg, #f5f5f7 0%, #e8eefb 100%)",
          fontFamily: "sans-serif",
          color: "#1d1d1f",
        }}
      >
        <div
          style={{
            position: "relative",
            width: 360,
            height: 360,
            borderRadius: 180,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "linear-gradient(160deg, #0071e3 0%, #5e5ce6 100%)",
            boxShadow: "0 24px 60px rgba(0,0,0,0.18)",
            flexShrink: 0,
          }}
        >
          {posterUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={posterUrl} width={360} height={360} style={{ objectFit: "cover", position: "absolute", top: 0, left: 0 }} alt="" />
          ) : (
            <div style={{ fontSize: 150, fontWeight: 700, color: "#ffffff" }}>B</div>
          )}
          <div
            style={{
              position: "absolute",
              width: 112,
              height: 112,
              borderRadius: 56,
              background: "rgba(255,255,255,0.92)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                width: 0,
                height: 0,
                marginLeft: 10,
                borderTop: "26px solid transparent",
                borderBottom: "26px solid transparent",
                borderLeft: "42px solid #0071e3",
              }}
            />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 56, maxWidth: 620 }}>
          <div style={{ fontSize: 30, color: "#6e6e73", marginBottom: 14 }}>
            {name ? "A 2-minute personal demo for" : "A personal demo from Belline"}
          </div>
          <div style={{ fontSize: name && name.length > 28 ? 52 : 64, fontWeight: 700, lineHeight: 1.08 }}>{name ?? "Meet Belle"}</div>
          <div style={{ display: "flex", marginTop: 28, fontSize: 26, color: "#1d1d1f" }}>
            <div
              style={{
                display: "flex",
                padding: "8px 18px",
                borderRadius: 999,
                background: "#ffffff",
                border: "1px solid #d2d2d7",
              }}
            >
              ▶ Watch · Belle, Belline&apos;s AI receptionist
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
