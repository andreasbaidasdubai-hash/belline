import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { signVisitorToken } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { newVisitorId } from "@/lib/webchat";
import { widgetOpenFor } from "@/lib/embed-preview";
import { findChatVenue, linkPageState } from "@/lib/chat-link";
import { answersIn, inHouseSpelling } from "@/lib/language";
import { CHAT_KEYS, copyTable } from "@/lib/customer-copy";
import { logoUrlFor } from "@/lib/logo";
import Chat from "@/app/embed/[key]/chat/Chat";

export const dynamic = "force-dynamic";

// Generic on purpose: the tab title and link previews must not name a venue
// that has not gone live.
export const metadata: Metadata = {
  title: "Chat",
  robots: { index: false, follow: false },
};

/**
 * The Belline chat link, full-screen. See lib/chat-link.ts.
 *
 * Not framable (next.config.mjs sends frame-ancestors 'none' for everything
 * but /call and /embed), so there is no origin to check: it is opened directly,
 * from a link. What stands between it and a stranger spending the venue's
 * money is the same as for the widget — activation, the entitlement and the
 * daily ceiling here, and the signed visitor token and per-conversation
 * ceiling on every turn.
 */
export default async function ChatLinkPage({ params }: { params: Promise<{ key: string }> }) {
  seedIfEmpty();
  const { key } = await params;

  const found = findChatVenue(key);
  // A widget key is not a link: the widget only opens inside the sites it names.
  if (!found || found.via !== "link") notFound();
  const { location } = found;

  const state = linkPageState(location, await widgetOpenFor(location));
  if (state.kind === "refused") return <Refused reason={state.message} />;

  return (
    <div style={{ height: "100dvh" }}>
      <Chat
        embedKey={key}
        freshToken={signVisitorToken(location.id, newVisitorId())}
        venueName={location.name}
        agentName={location.agent.displayName}
        logoUrl={logoUrlFor(location)}
        {...(answersIn(location) === "en"
          ? {}
          : {
              language: answersIn(location),
              copy: Object.fromEntries(
                Object.entries<string>(copyTable(answersIn(location), CHAT_KEYS)).map(([k, v]) => [k, inHouseSpelling(location, v)]),
              ) as Record<(typeof CHAT_KEYS)[number], string>,
            })}
      />
    </div>
  );
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
        background: "var(--bl-ground)",
        color: "var(--bl-ink-900)",
        fontFamily: "var(--bl-font-text)",
      }}
    >
      <p data-testid="chat-link-refused" style={{ margin: 0, fontSize: 15, lineHeight: 1.6, maxWidth: "34ch", opacity: 0.9 }}>
        {reason}
      </p>
    </div>
  );
}
