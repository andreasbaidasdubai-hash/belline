import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { createProspectDemo, listProspects } from "@/lib/prospect";

export const dynamic = "force-dynamic";

/**
 * Build a personalised demo from a prospect's website.
 *
 * Signed in only. This fetches an arbitrary URL, spends model tokens, and
 * publishes a page carrying somebody else's trading name — none of which
 * belongs on an open endpoint.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  // Ours. Reads a stranger's website through the model and builds a venue
  // from it — a selling tool, not something a customer's owner does.
  if (!isBellineStaff(auth.user)) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Set ANTHROPIC_API_KEY to read a business off a website." },
      { status: 503 },
    );
  }

  const { url } = (await request.json()) as { url?: string };
  if (!url?.trim()) {
    return NextResponse.json({ error: "Give me the prospect's website address." }, { status: 400 });
  }

  try {
    const location = await createProspectDemo(url.trim());
    return NextResponse.json({
      ok: true,
      slug: location.prospect!.slug,
      name: location.name,
      vertical: location.vertical,
      expiresAt: location.prospect!.expiresAt,
    });
  } catch (err) {
    // These messages are written to be read by a salesperson mid-call, so they
    // say what to do rather than what threw.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not build that demo." },
      { status: 422 },
    );
  }
}

export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!isBellineStaff(auth.user)) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  return NextResponse.json({
    prospects: listProspects().map((l) => ({
      slug: l.prospect!.slug,
      name: l.name,
      vertical: l.vertical,
      sourceUrl: l.prospect!.sourceUrl,
      expiresAt: l.prospect!.expiresAt,
    })),
  });
}
