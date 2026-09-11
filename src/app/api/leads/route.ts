import { NextResponse } from "next/server";
import { buildLead, findRecentDuplicate } from "@/lib/leads";
import { listLeads, saveLead } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * "Book a call" from the marketing site.
 *
 * The only endpoint in the product that accepts a write from a stranger, so it
 * is the only one that needs its own rate limit. Everything else is either
 * behind a session or behind a Twilio signature.
 *
 * CORS is open on purpose: the marketing site is served from belline.ai on
 * Vercel and this runs on app.belline.ai, so a same-origin policy would block
 * the form entirely. Open is safe here because the endpoint only ever creates
 * a lead — there is no session to ride, nothing to read back, and nothing a
 * cross-site request could obtain that it could not obtain by asking directly.
 */

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;

const attempts = new Map<string, number[]>();

/**
 * Behind Railway's proxy the socket address is the proxy, so the client is the
 * first entry in x-forwarded-for. Taking the last would rate-limit the proxy
 * itself and lock out every visitor at once.
 */
function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);

  // Keep the map from growing without bound on a long-running server.
  if (attempts.size > 5000) {
    for (const [k, times] of attempts) {
      if (times.every((t) => now - t >= WINDOW_MS)) attempts.delete(k);
    }
  }
  return recent.length > MAX_PER_WINDOW;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(request: Request) {
  if (rateLimited(clientKey(request))) {
    return NextResponse.json(
      { error: "That is a lot of enquiries. Email hello@belline.ai and we will come straight back." },
      { status: 429, headers: CORS },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Could not read that." }, { status: 400, headers: CORS });
  }

  const result = await buildLead(body as Record<string, unknown>);

  if (!result.ok) {
    // The honeypot answers 200 with a plausible success. A bot told it failed
    // simply retries with the field renamed.
    if (result.field === "website2") {
      return NextResponse.json({ ok: true }, { headers: CORS });
    }
    return NextResponse.json(
      {
        error: result.error,
        field: result.field,
        suggestion: result.suggestion,
        confirmable: result.confirmable,
      },
      { status: 422, headers: CORS },
    );
  }

  const duplicate = findRecentDuplicate(listLeads(), result.lead);
  if (duplicate) {
    // Idempotent by intent, like the booking engine: somebody who fills the
    // form twice because nobody has replied yet should not become two rows a
    // salesperson rings separately.
    return NextResponse.json(
      { ok: true, duplicate: true, message: "We already have this — we will be in touch shortly." },
      { headers: CORS },
    );
  }

  saveLead(result.lead);

  return NextResponse.json(
    {
      ok: true,
      message: "Booked in. We will email you a Zoom link with a couple of times.",
      // So the form can say "we could not verify that domain" without refusing.
      emailUnverified: result.lead.emailCheck.mx === null,
    },
    { headers: CORS },
  );
}
