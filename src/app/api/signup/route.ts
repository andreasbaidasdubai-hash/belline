import { NextResponse } from "next/server";
import { signUp } from "@/lib/onboarding";
import { seedIfEmpty } from "@/lib/seed";
import { SESSION_COOKIE, login } from "@/lib/auth";
import { sessionCookieOptions } from "@/lib/auth-server";
import type { Vertical } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Create an account.
 *
 * The one route on this server that is public, unauthenticated and writes. It
 * exists because the alternative — a form that emails a salesperson — is four
 * humans in the loop for a product priced at one, and because "Get Belline"
 * is not an honest button until this works.
 *
 * Being public is the whole point and also the whole risk, so:
 *
 *   Rate limited by address. Not to stop a determined attacker, who will use
 *   more than one, but to stop the ordinary case: a script that finds the
 *   endpoint and creates ten thousand tenants overnight.
 *
 *   Validated in the library, not here. `signUp` checks every field and
 *   returns which one failed, so the browser can put the message next to the
 *   right input rather than at the top of the page.
 *
 *   Signed in on success. A customer who has just typed a password should not
 *   be asked for it again on the next screen.
 */

/**
 * A small, deliberately leaky bucket.
 *
 * In memory, per process, and reset by a redeploy — which is fine for what it
 * is defending against. Something stronger belongs in front of the whole
 * service rather than inside one route handler, and pretending otherwise
 * would be security theatre with a Map in it.
 */
const RECENT = new Map<string, number[]>();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;

function tooMany(ip: string): boolean {
  const now = Date.now();
  const hits = (RECENT.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  RECENT.set(ip, hits);
  // Keep the map from growing without bound on a long-lived process.
  if (RECENT.size > 5000) {
    for (const [key, times] of RECENT) {
      if (!times.some((t) => now - t < WINDOW_MS)) RECENT.delete(key);
    }
  }
  return hits.length > MAX_PER_WINDOW;
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

export async function POST(req: Request) {
  seedIfEmpty();

  if (tooMany(clientIp(req))) {
    return NextResponse.json(
      { error: "Too many accounts from here just now. Try again in an hour." },
      { status: 429 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Send JSON." }, { status: 400 });
  }

  const result = await signUp({
    businessName: String(body.businessName ?? ""),
    email: String(body.email ?? ""),
    password: String(body.password ?? ""),
    vertical: String(body.vertical ?? "") as Vertical,
    timezone: body.timezone ? String(body.timezone) : undefined,
  });

  if (!result.ok) {
    // 422 rather than 400: the request was well formed, the contents were not.
    return NextResponse.json({ field: result.field, error: result.error }, { status: 422 });
  }

  // Straight in. No confirmation email standing between somebody who has just
  // paid us attention and the thing they came for.
  const session = login(
    result.user.email,
    String(body.password),
    req.headers.get("user-agent") ?? undefined,
  );

  const response = NextResponse.json({
    ok: true,
    locationId: result.location.id,
    next: "/setup",
  });

  if (session.ok) {
    const maxAge = Math.floor((Date.parse(session.session.expiresAt) - Date.now()) / 1000);
    response.cookies.set(SESSION_COOKIE, session.session.id, sessionCookieOptions(maxAge));
  }

  return response;
}
