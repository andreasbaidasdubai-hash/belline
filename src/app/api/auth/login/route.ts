import { NextResponse } from "next/server";
import { SESSION_COOKIE, isBellineStaff, login } from "@/lib/auth";
import { listLocationsFor } from "@/lib/store";
import { navCollapsed } from "@/lib/onboarding/journey";
import { sessionCookieOptions } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  seedIfEmpty();

  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };

  if (!body.email || !body.password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  const result = login(
    body.email,
    body.password,
    request.headers.get("user-agent") ?? undefined,
  );

  if (!result.ok) {
    // 401 for every failure, with one message: distinguishing "no such user"
    // from "wrong password" hands an attacker a list of valid accounts.
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  const maxAge = Math.floor(
    (Date.parse(result.session.expiresAt) - Date.now()) / 1000,
  );
  // Somebody whose business is still being set up goes back to setup, which
  // resumes on the step they left. Everybody else lands on the dashboard.
  const venues = listLocationsFor(result.user.tenantId);
  const next = navCollapsed(venues, isBellineStaff(result.user)) ? "/setup" : "/";

  const response = NextResponse.json({
    ok: true,
    next,
    user: { name: result.user.name, role: result.user.role },
  });
  response.cookies.set(SESSION_COOKIE, result.session.id, sessionCookieOptions(maxAge));
  return response;
}
