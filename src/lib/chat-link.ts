import crypto from "node:crypto";
import type { Location } from "./types";
import { listLocations, upsertLocation } from "./store";
import { chatAllowed } from "./embed";
import { appOrigin } from "./origin";
import { chatGate } from "./webchat";
import { lineFor } from "./language";
import { copy } from "./customer-copy";

/**
 * The Belline chat link: a channel that needs no website.
 *
 * A public page, /c/<key>, that opens the venue's chat full-screen — for an
 * Instagram bio, a Google Business Profile, a WhatsApp status. An owner who
 * cannot paste a line of code into their site still has a way for customers
 * to reach Belline in writing.
 *
 * It is the website chat without the website, and it is held to everything the
 * widget is held to, through the same code:
 *
 *   - **Activation.** It answers only once the venue is live (Go live, which
 *     needs the eight checks). Before that, a stranger sees one neutral
 *     sentence: not the venue's name, not its agent, nothing about it. Only the
 *     owner, signed in, can preview it — as with the widget.
 *   - **Entitlement and ceilings.** `chatGate(location, { via: "link" })`: the
 *     trial's text conversations, the plan's pool and the venue's daily
 *     conversation ceiling, shared with the widget.
 *   - **Honesty guards and PII.** The turn is the web chat turn
 *     (webchat-turn.ts → respondTo), so every guard on a website conversation
 *     applies unchanged, and a visitor is an anonymous signed id, never a
 *     phone number.
 *
 * Its own key rather than the widget's: the widget's key sits in page source
 * with an origin allowlist behind it, and this one is meant to be posted
 * publicly with no framing at all. Different keys can be revoked apart.
 */

export function newChatLinkKey(): string {
  return `bc_${crypto.randomBytes(12).toString("base64url")}`;
}

export type ChatVia = "widget" | "link";

/** The venue a chat key belongs to, and whether it came in by the widget or the link. */
export function findChatVenue(key: string): { location: Location; via: ChatVia } | null {
  if (!key) return null;
  const all = listLocations({ includeInternal: true });
  const widget = all.find((l) => l.embed?.enabled && l.embed.key === key && chatAllowed(l.embed));
  if (widget) return { location: widget, via: "widget" };
  const link = all.find((l) => l.chatLink?.key === key);
  return link ? { location: link, via: "link" } : null;
}

export function chatLinkUrl(location: Pick<Location, "chatLink">, origin: string = appOrigin()): string | null {
  return location.chatLink ? `${origin}/c/${encodeURIComponent(location.chatLink.key)}` : null;
}

/** Create the venue's link, once. A second call returns the same link. */
export function ensureChatLink(location: Location, by?: string, now: Date = new Date()): Location {
  if (location.chatLink) return location;
  return upsertLocation({
    ...location,
    chatLink: { key: newChatLinkKey(), createdAt: now.toISOString(), ...(by ? { createdBy: by } : {}) },
  });
}

/** Said to anybody who opens a link that is not answering yet. Nothing about the venue. */
export const LINK_NOT_LIVE = copy("en", "chatlink.not_live");

export type LinkPage =
  | { kind: "chat" }
  | { kind: "refused"; message: string };

/**
 * What the public page shows. `open` is whether the chat may answer this
 * person: the venue is live, or the viewer is its signed-in owner previewing.
 * Before that, the refusal names nothing.
 */
export function linkPageState(location: Location, open: boolean): LinkPage {
  if (!location.chatLink || !open) return { kind: "refused", message: lineFor(location, "chatlink.not_live") };
  const gate = chatGate(location, { via: "link" });
  if (!gate.allowed) return { kind: "refused", message: gate.message ?? lineFor(location, "chatlink.unavailable") };
  return { kind: "chat" };
}
