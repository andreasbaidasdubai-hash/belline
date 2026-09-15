import { NextResponse } from "next/server";
import { SESSION_COOKIE, consumeLoginToken, startSession } from "@/lib/auth";
import { sessionCookieOptions } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { appOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/**
 * A sign-in link, from an email Belle sent.
 *
 * Used once and then gone. A link that is expired, already used or forged
 * lands on the sign-in page with a sentence saying so, rather than an error.
 * Both redirects go to the public origin: the request's own is the container's.
 */
export async function GET(req: Request) {
  seedIfEmpty();
  const url = new URL(req.url);
  const user = consumeLoginToken(url.searchParams.get("t") ?? undefined);

  if (!user) {
    return NextResponse.redirect(new URL("/login?link=expired", appOrigin()));
  }

  const session = startSession(user, req.headers.get("user-agent") ?? undefined);
  const response = NextResponse.redirect(new URL("/setup", appOrigin()));
  const maxAge = Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000);
  response.cookies.set(SESSION_COOKIE, session.id, sessionCookieOptions(maxAge));
  return response;
}
