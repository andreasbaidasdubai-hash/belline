import { NextResponse } from "next/server";
import { cleanClientId, resolveVisitor, visitorCatchUp, visitorTurn } from "@/lib/webchat-turn";

export const dynamic = "force-dynamic";

/**
 * Web chat, typed.
 *
 * POST sends a message and returns everything said since. GET returns anything
 * newer than what the page has shown — which is also how a colleague's reply
 * from the inbox reaches a website visitor, with no second mechanism.
 *
 * The checks, the ceilings and the turn itself are in webchat-turn.ts, shared
 * with the voice-note route beside this one.
 */

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;

  let body: { token?: string; text?: string; clientId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Send JSON." }, { status: 400 });
  }

  const visitor = await resolveVisitor(key, body.token);
  if (visitor instanceof NextResponse) return visitor;

  const text = String(body.text ?? "").trim().slice(0, 1000);
  if (!text) return NextResponse.json({ error: "Nothing to send." }, { status: 400 });

  // The id the visitor's page generated for this message. It becomes the dedup
  // key, so a retry after a dropped connection is a no-op rather than a second
  // question — the same defence the WhatsApp webhook has, for the same reason.
  const clientId = cleanClientId(body.clientId);
  if (!clientId) return NextResponse.json({ error: "Missing message id." }, { status: 400 });

  return visitorTurn(visitor, { text, clientId });
}

export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const url = new URL(req.url);

  const visitor = await resolveVisitor(key, url.searchParams.get("token") ?? undefined);
  if (visitor instanceof NextResponse) return visitor;

  const after = Number(url.searchParams.get("after") ?? 0) || 0;
  return visitorCatchUp(visitor, after);
}
