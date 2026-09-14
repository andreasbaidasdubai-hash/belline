import { NextResponse } from "next/server";
import { SESSION_COOKIE, consumeLoginToken, startSession } from "@/lib/auth";
import { sessionCookieOptions } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";

export const dynamic = "force-dynamic";

/**
 * A sign-in link, from an email Belle sent.
 *
 * Used once and then gone. A link that is expired, already used or forged
 * lands on the sign-in page with a sentence saying so, rather than an error.
 */
export async function GET(req: Request) {
  seedIfEmpty();
  const url = new URL(req.url);
  const user = consumeLoginToken(url.searchParams.get("t") ?? undefined);

  if (!user) {
    return NextResponse.redirect(new URL("/login?link=expired", url.origin));
  }

  const session = startSession(user, req.headers.get("user-agent") ?? undefined);
  const response = NextResponse.redirect(new URL("/setup", url.origin));
  const maxAge = Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000);
  response.cookies.set(SESSION_COOKIE, session.id, sessionCookieOptions(maxAge));
  return response;
}
