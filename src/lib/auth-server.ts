import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import type { Location, User } from "./types";
import { SESSION_COOKIE, userForSession, visibleLocations } from "./auth";

/**
 * The Next-facing half of authentication. Split from `auth.ts` so the
 * websocket bridge can use the same session logic without dragging
 * `next/headers` into a plain Node process.
 */

export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  return userForSession(jar.get(SESSION_COOKIE)?.value);
}

/**
 * For pages and layouts. Redirects to the login screen when there is no
 * session, so a guarded layout is one line.
 */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * For route handlers. Returns the user, or a 401 to hand straight back —
 * an API must never answer an unauthenticated request with a redirect to a
 * login page, because `fetch` will follow it and the caller gets HTML.
 */
export async function requireApiUser(): Promise<
  { user: User; response?: never } | { user?: never; response: NextResponse }
> {
  const user = await currentUser();
  if (!user) {
    return {
      response: NextResponse.json({ error: "Not signed in." }, { status: 401 }),
    };
  }
  return { user };
}

/**
 * The venue a page should show.
 *
 * Every dashboard page takes `?loc=` from the URL, so this is the choke point
 * that stops a member of floor staff at one venue reading another's guest
 * list by editing the address bar. An out-of-scope id silently falls back to
 * a venue they can see rather than erroring — it is a stale bookmark far more
 * often than it is an attack.
 */
export async function resolveLocation(
  user: User,
  requested?: string,
): Promise<Location | null> {
  const allowed = visibleLocations(user);
  if (allowed.length === 0) return null;
  return allowed.find((l) => l.id === requested) ?? allowed[0];
}

export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Behind Railway/Fly the app is served over TLS; in local development it
    // is plain http, where a Secure cookie would simply never be stored.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
