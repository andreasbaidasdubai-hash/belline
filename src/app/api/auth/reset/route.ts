import { NextResponse } from "next/server";
import { SESSION_COOKIE, consumeResetToken, isBellineStaff } from "@/lib/auth";
import { sessionCookieOptions } from "@/lib/auth-server";
import { listLocationsFor } from "@/lib/store";
import { navCollapsed } from "@/lib/onboarding/journey";
import { seedIfEmpty } from "@/lib/seed";

export const dynamic = "force-dynamic";

/**
 * Set a new password from a reset link.
 *
 * The link is used up here, not when the page opens. Success signs out every
 * other session and signs this browser in, straight back to where the owner
 * was: setup if the business is not live yet, the dashboard otherwise.
 */
export async function POST(request: Request) {
  seedIfEmpty();
  const body = (await request.json().catch(() => ({}))) as { token?: unknown; password?: unknown };
  const token = typeof body.token === "string" ? body.token.slice(0, 400) : undefined;
  const password = typeof body.password === "string" ? body.password : "";

  const result = consumeResetToken(token, password, request.headers.get("user-agent") ?? undefined);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, field: result.field }, { status: result.field === "token" ? 410 : 422 });
  }

  const venues = listLocationsFor(result.user.tenantId);
  const next = navCollapsed(venues, isBellineStaff(result.user)) ? "/setup" : "/";
  const maxAge = Math.floor((Date.parse(result.session.expiresAt) - Date.now()) / 1000);
  const response = NextResponse.json({ ok: true, next });
  response.cookies.set(SESSION_COOKIE, result.session.id, sessionCookieOptions(maxAge));
  return response;
}
