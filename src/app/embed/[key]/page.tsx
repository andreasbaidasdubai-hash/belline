import { notFound } from "next/navigation";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { signStreamToken } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { listLocations } from "@/lib/store";
import { checkEmbedGate, originAllowed } from "@/lib/embed";
import { chatAllowed } from "@/lib/webchat";
import Console from "../../(app)/test/Console";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Call",
  // Never indexable. This is a widget opened from somebody else's site, not a
  // page that should turn up in a search for their business.
  robots: { index: false, follow: false },
};

/**
 * A venue's own receptionist, on a venue's own website.
 *
 * Framed by the customer's page, opened by the bell that `embed.js` injects.
 * The visitor is talking to that venue's Belline — the same agent, the same
 * diary, the same refusals as the telephone.
 *
 * Three checks before a word is spoken, in this order:
 *
 *   1. The key names a venue with the widget switched on.
 *   2. The page framing it is one the venue named. Enforced twice: here, so a
 *      direct visit gets a clear refusal, and by the browser through
 *      `frame-ancestors`, which is the one that actually holds.
 *   3. The widget has not had its day's worth of calls.
 *
 * The middleware sets the frame-ancestors header — a page cannot set its own,
 * because by the time React renders, the browser has already decided whether
 * to frame it.
 */
export default async function EmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ o?: string }>;
}) {
  seedIfEmpty();
  const { key } = await params;
  const { o } = await searchParams;

  const location = listLocations({ includeInternal: true }).find(
    (l) => l.embed?.enabled && l.embed.key === key,
  );
  if (!location?.embed) notFound();

  // Who is framing us. `sec-fetch-site` tells us whether we are framed at all;
  // `referer` is the only thing that names the page when it is a same-origin
  // navigation inside an iframe.
  const head = await headers();
  const framedBy = head.get("origin") ?? refererOrigin(head.get("referer"));

  // A direct visit — somebody pasted the URL — has no framing origin. Refused
  // rather than allowed: the widget is for the venue's site, and a public URL
  // anybody can open is a public URL anybody can spend.
  if (!originAllowed(location.embed, framedBy)) {
    return <Refused reason="This page can only be opened from the website it belongs to." />;
  }

  const gate = checkEmbedGate(location);
  if (!gate.allowed) {
    return <Refused reason={gate.message ?? "Not available just now."} />;
  }

  const token = signStreamToken(location.id, 60 * 60);

  return (
    <Console
      locationId={location.id}
      locationName={location.name}
      demoToken={token}
      compact
      minimal
      auto
      logoUrl={location.logoUrl}
      // The 2-in-1, offered only where the venue switched both on. The framing
      // origin has to ride along: the middleware builds frame-ancestors from
      // it on every response, and without it the browser refuses the page.
      chatHref={
        chatAllowed(location.embed)
          ? `/embed/${encodeURIComponent(key)}/chat${o ? `?o=${encodeURIComponent(o)}` : ""}`
          : undefined
      }
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

/**
 * A refusal a visitor can read.
 *
 * Never says why in technical terms. Somebody who has hit a daily cap on a
 * salon's website should be told to ring the salon, not told about a cap.
 */
function Refused({ reason }: { reason: string }) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: 28,
        textAlign: "center",
        background: "#14110D",
        color: "#FBF9F5",
        fontFamily: '"Instrument Sans", ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, maxWidth: "34ch", opacity: 0.9 }}>
        {reason}
      </p>
    </div>
  );
}
