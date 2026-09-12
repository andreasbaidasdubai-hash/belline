import { notFound } from "next/navigation";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { signVisitorToken } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { listLocations } from "@/lib/store";
import { originAllowed } from "@/lib/embed";
import { chatAllowed, chatGate, newVisitorId, voiceAllowed } from "@/lib/webchat";
import Chat from "./Chat";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Chat",
  robots: { index: false, follow: false },
};

/**
 * Belline, typed, inside a venue's own website.
 *
 * The same three checks as the voice widget, in the same order, for the same
 * reasons — the key names a venue with the widget on, the page framing it is one
 * the venue named, and the day's ceiling has not been reached. What is different
 * is what happens after they pass: this page mints the visitor's signed identity
 * and hands it to the browser.
 *
 * That is deliberate and it is the whole security model of the chat endpoint.
 * Everything a visitor can do afterwards is authorised by a token that only
 * exists because this page ran, and this page only runs for an allowlisted
 * origin. `/api/webchat/[key]` therefore never has to ask who is framing it —
 * which is just as well, since a `fetch` from inside an iframe reports our own
 * origin and would have proved nothing while looking like proof.
 */
export default async function ChatPage({
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

  // The venue may have the bell on and the chat off. Not a 404: the key is
  // real, the venue is real, and somebody has pasted `data-mode="chat"` onto a
  // widget that is not switched on for it. A readable refusal is how they find
  // that out, rather than an empty frame.
  if (!chatAllowed(location.embed)) {
    return <Refused reason="Chat isn't switched on for this website yet." />;
  }

  const head = await headers();
  const framedBy = head.get("origin") ?? refererOrigin(head.get("referer"));
  if (!originAllowed(location.embed, framedBy)) {
    return <Refused reason="This page can only be opened from the website it belongs to." />;
  }

  const gate = chatGate(location);
  if (!gate.allowed) {
    return <Refused reason={gate.message ?? "Not available just now."} />;
  }

  return (
    <Chat
      embedKey={key}
      // A fresh identity on every render. The browser keeps the one it already
      // has for this session and uses this only when it has none — otherwise
      // reloading the venue's page would abandon a half-finished booking and
      // start a second conversation in the inbox beside it.
      freshToken={signVisitorToken(location.id, newVisitorId())}
      venueName={location.name}
      agentName={location.agent.displayName}
      /** The 2-in-1: offered only where the venue has the bell on as well. */
      voiceHref={voiceAllowed(location.embed) ? voiceUrl(key, o) : undefined}
    />
  );
}

/**
 * The same widget, switched to talking.
 *
 * The framing origin has to ride along, because the middleware builds
 * `frame-ancestors` from it on every response — drop it and the browser refuses
 * the page the visitor just asked for.
 */
function voiceUrl(key: string, o: string | undefined): string {
  const base = `/embed/${encodeURIComponent(key)}`;
  return o ? `${base}?o=${encodeURIComponent(o)}` : base;
}

function refererOrigin(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

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
