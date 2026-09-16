import { NextResponse } from "next/server";
import { SESSION_COOKIE, login } from "@/lib/auth";
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
  // Everybody lands on the dashboard. An owner part way through setup finds
  // the checklist on Today with the next step one press away: setup never
  // stands between an owner and their own dashboard.
  const next = "/";

  const response = NextResponse.json({
    ok: true,
    next,
    user: { name: result.user.name, role: result.user.role },
  });
  response.cookies.set(SESSION_COOKIE, result.session.id, sessionCookieOptions(maxAge));
  return response;
}
