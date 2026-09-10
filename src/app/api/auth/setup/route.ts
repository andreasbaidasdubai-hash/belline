import { NextResponse } from "next/server";
import { SESSION_COOKIE, createUser, login } from "@/lib/auth";
import { sessionCookieOptions } from "@/lib/auth-server";
import { hasNoUsers } from "@/lib/store";
import { seedIfEmpty } from "@/lib/seed";

export const dynamic = "force-dynamic";

/**
 * First-run owner creation.
 *
 * Open by necessity — there is nobody to authenticate against yet — and
 * therefore closed the instant one account exists. Whoever reaches a fresh
 * deployment first becomes the owner, so do not leave a new deployment
 * sitting on a public URL before signing in.
 */
export async function POST(request: Request) {
  seedIfEmpty();

  if (!hasNoUsers()) {
    return NextResponse.json(
      { error: "This dashboard is already set up. Sign in instead." },
      { status: 409 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    name?: string;
  };

  if (!body.email || !body.password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  const created = createUser({
    email: body.email,
    name: body.name ?? "",
    password: body.password,
    role: "owner",
  });
  if (!created.ok) {
    return NextResponse.json({ error: created.error }, { status: 400 });
  }

  const result = login(
    body.email,
    body.password,
    request.headers.get("user-agent") ?? undefined,
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  const maxAge = Math.floor((Date.parse(result.session.expiresAt) - Date.now()) / 1000);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, result.session.id, sessionCookieOptions(maxAge));
  return response;
}
