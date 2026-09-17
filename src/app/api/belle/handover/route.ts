import { NextResponse } from "next/server";
import { belleOwner } from "@/lib/belle/server";
import { openSupportHandover } from "@/lib/belle/support";

export const dynamic = "force-dynamic";

/**
 * "Talk to a person" in Ask Belle.
 *
 * Opens the existing ticket for the Belline team (`owner_requested_human`,
 * source belle) with the page and the last lines of the conversation, and
 * tells the owner the team will reply by email. The button is the request:
 * the typed "ask twice" rule does not apply to a press. No model call.
 */
export async function POST(req: Request) {
  let body: { locationId?: unknown; page?: unknown; messages?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Send JSON." }, { status: 400 });
  }
  const gate = await belleOwner(body.locationId);
  if (!gate.ok) return gate.response;

  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter(
      (m): m is { role: "user" | "assistant"; content: string } =>
        Boolean(m) && typeof m === "object" && ((m as { role?: unknown }).role === "user" || (m as { role?: unknown }).role === "assistant") && typeof (m as { content?: unknown }).content === "string",
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
    .slice(-8);

  const out = openSupportHandover({
    user: gate.user,
    location: gate.location,
    page: typeof body.page === "string" ? body.page.slice(0, 200) : undefined,
    history,
  });
  if (!out) return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  return NextResponse.json({ ok: true, ticket: out.ticket, reply: out.reply });
}
