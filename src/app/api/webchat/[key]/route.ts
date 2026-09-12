import { NextResponse } from "next/server";
import { verifyVisitorToken } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { listLocations } from "@/lib/store";
import type { Location } from "@/lib/types";
import { migrateReception } from "@/lib/reception/migrate";
import { isConfigured } from "@/lib/db/client";
import { acceptInbound } from "@/lib/reception/inbound";
import { respondTo } from "@/lib/reception/respond";
import { findCustomer, listMessages, openConversationFor } from "@/lib/reception/repo";
import type { Conversation, Message } from "@/lib/reception/types";
import {
  ceilingMessage,
  chatAllowed,
  chatGate,
  ensureWebchatAccount,
  messageCeiling,
  releaseTurnSlot,
  takeTurnSlot,
  visitorHandle,
} from "@/lib/webchat";

export const dynamic = "force-dynamic";

/**
 * Web chat, from the visitor's side.
 *
 * Public, unauthenticated, and it spends money on every request, which makes it
 * the most exposed thing in this application. Four checks stand between it and
 * somebody's free Claude account, in this order, and none of them is the embed
 * key — the key is in the customer's page source and always will be:
 *
 *   1. **A signed visitor token.** Minted by the chat page, and only after that
 *      page has established it is framed by a site the venue named. There is no
 *      path to this endpoint that does not go through that page first, which is
 *      why the origin is not re-checked here — a `fetch` from an iframe reports
 *      our own origin, so checking it would prove nothing and read as though it
 *      proved something.
 *   2. **The token's venue matches the key's venue.** Otherwise one venue's
 *      widget could spend another's ceiling.
 *   3. **One turn per visitor at a time.** The double-click, which would
 *      otherwise run two turns whose histories each miss the other's reply.
 *   4. **Two ceilings, the venue's own.** Conversations a day, messages in one
 *      conversation.
 *
 * POST sends a message and returns everything said since. GET returns anything
 * newer than what the page has shown — which is also how a colleague's reply
 * from the inbox reaches a website visitor, with no second mechanism.
 */

interface Resolved {
  location: Location;
  visitorId: string;
  handle: string;
}

async function resolve(
  key: string,
  token: string | undefined,
): Promise<Resolved | NextResponse> {
  // The token first. It is an HMAC check, costs nothing, and refuses the
  // unauthenticated flood before it reaches the database — the migration
  // ledger and the seed were running for every request that arrived here,
  // token or no token.
  const claim = verifyVisitorToken(token);
  if (!claim) {
    // Includes the expired case. The page mints a fresh one on reload, so the
    // recovery a visitor needs is the one they would try anyway.
    return NextResponse.json({ error: "expired" }, { status: 401 });
  }

  if (!isConfigured()) {
    // Reception needs Postgres. Said plainly rather than as a 500, because the
    // one person who will ever see it is a developer without DATABASE_URL.
    return NextResponse.json({ error: "Chat is not configured." }, { status: 503 });
  }
  await migrateReception();
  seedIfEmpty();

  const location = listLocations({ includeInternal: true }).find(
    (l) => l.embed?.enabled && l.embed.key === key,
  );
  if (!location || !chatAllowed(location.embed)) {
    return NextResponse.json({ error: "Chat is not available here." }, { status: 404 });
  }
  if (claim.locationId !== location.id) {
    return NextResponse.json({ error: "Wrong venue." }, { status: 403 });
  }

  return { location, visitorId: claim.visitorId, handle: visitorHandle(claim.visitorId) };
}

// ---------------------------------------------------------------------------

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;

  let body: { token?: string; text?: string; clientId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Send JSON." }, { status: 400 });
  }

  const resolved = await resolve(key, body.token);
  if (resolved instanceof NextResponse) return resolved;
  const { location, visitorId, handle } = resolved;

  const text = String(body.text ?? "").trim().slice(0, 1000);
  if (!text) return NextResponse.json({ error: "Nothing to send." }, { status: 400 });

  // The id the visitor's page generated for this message. It becomes the dedup
  // key, so a retry after a dropped connection is a no-op rather than a second
  // question — the same defence the WhatsApp webhook has, for the same reason.
  const clientId = String(body.clientId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  if (!clientId) return NextResponse.json({ error: "Missing message id." }, { status: 400 });

  if (!takeTurnSlot(visitorId)) {
    return NextResponse.json({ error: "One at a time." }, { status: 429 });
  }

  try {
    const existing = await conversationFor(location, handle);

    // A conversation that has run long enough to need a person. Recorded, not
    // answered: the transcript should show what they asked, and the inbox
    // should show it waiting.
    if (existing) {
      const count = (await listMessages(location.tenantId, existing.id)).filter(
        (m) => m.sender === "customer",
      ).length;
      if (count >= messageCeiling(location)) {
        return NextResponse.json({
          ok: true,
          messages: [{ id: -1, sender: "ai", body: ceilingMessage(location), createdAt: now() }],
          status: existing.status,
          ceiling: true,
        });
      }
    } else {
      // A brand new conversation, which is what the daily ceiling counts.
      const gate = chatGate(location);
      if (!gate.allowed) {
        return NextResponse.json({
          ok: true,
          messages: [
            { id: -1, sender: "ai", body: gate.message ?? "Not available just now.", createdAt: now() },
          ],
          status: "AI_ACTIVE" as const,
          ceiling: true,
        });
      }
    }

    const account = await ensureWebchatAccount(location);

    const accepted = await acceptInbound(
      {
        channel: "webchat",
        provider: "webchat",
        providerMessageId: `web_${clientId}`,
        fromE164: handle,
        content: { type: "text", text },
        timestamp: now(),
        // Nothing to keep. A provider envelope is worth storing because it is
        // the evidence of what a third party actually sent us; this request had
        // no third party in it.
        raw: {},
      },
      account,
    );

    if (!accepted.ok) {
      return NextResponse.json({ error: accepted.rejected.detail }, { status: 400 });
    }

    const { conversationId } = accepted.accepted;

    // Only answer a message we have not seen. A retry after a dropped
    // connection must not produce a second turn.
    if (accepted.accepted.fresh) {
      await respondTo(accepted.accepted);
    }

    const messages = await listMessages(location.tenantId, conversationId);

    // Everything said after the visitor's own message — which is what makes a
    // retry return the reply it already produced instead of silence. Anchored
    // on the stored message rather than on a timestamp or a count, because the
    // retry's anchor has to be the *first* attempt's row.
    const anchor = messages.find((m) => m.providerMessageId === `web_${clientId}`);
    const since = anchor?.id ?? 0;
    const fresh = messages.filter((m) => m.id > since && m.direction === "out");

    const state = await conversationFor(location, handle);

    return NextResponse.json({
      ok: true,
      messages: fresh.map(forVisitor),
      status: state?.status ?? "AI_ACTIVE",
      lastId: messages.length ? messages[messages.length - 1].id : since,
    });
  } finally {
    releaseTurnSlot(visitorId);
  }
}

/**
 * Anything said since the page last looked.
 *
 * The only way a member of staff's reply reaches a website visitor. Which is
 * also the argument for polling over a socket here: the inbox writes a row and
 * is finished, with nothing to know about who is connected to what.
 */
export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const url = new URL(req.url);

  const resolved = await resolve(key, url.searchParams.get("token") ?? undefined);
  if (resolved instanceof NextResponse) return resolved;
  const { location, handle } = resolved;

  const after = Number(url.searchParams.get("after") ?? 0) || 0;

  const conversation = await conversationFor(location, handle);
  if (!conversation) {
    return NextResponse.json({ ok: true, messages: [], status: "AI_ACTIVE", lastId: after });
  }

  const messages = await listMessages(location.tenantId, conversation.id);
  const fresh = messages.filter((m) => m.id > after && m.direction === "out");

  return NextResponse.json({
    ok: true,
    messages: fresh.map(forVisitor),
    status: conversation.status,
    lastId: messages.length ? messages[messages.length - 1].id : after,
  });
}

// ---------------------------------------------------------------------------

async function conversationFor(
  location: Location,
  handle: string,
): Promise<Conversation | undefined> {
  const customer = await findCustomer(location.tenantId, handle);
  if (!customer) return undefined;
  return openConversationFor(location.tenantId, customer.id, "webchat");
}

/**
 * A message as the visitor may see it.
 *
 * Whitelisted rather than filtered. `meta` holds provider payloads and
 * `error` holds why a send failed; neither is a visitor's business, and a
 * spread with a couple of deletes is how one of them ends up on a public page
 * after somebody adds a field.
 */
function forVisitor(m: Message) {
  return {
    id: m.id,
    // 'human' and 'ai' are both "the business" to a visitor. The distinction is
    // real and it is in the inbox, where a colleague can see who said what; on
    // the visitor's side it would only invite them to distrust half the thread.
    sender: m.sender === "customer" ? "customer" : m.sender === "system" ? "system" : "business",
    body: m.body ?? "",
    createdAt: m.createdAt,
  };
}

function now(): string {
  return new Date().toISOString();
}
