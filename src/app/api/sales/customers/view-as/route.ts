import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireApiUser, sessionCookieOptions } from "@/lib/auth-server";
import { SESSION_COOKIE, isBellineStaff } from "@/lib/auth";
import { VIEW_AS_MINUTES, startViewAs } from "@/lib/staff/view-as";

export const dynamic = "force-dynamic";

/**
 * Open a customer's dashboard as its owner, read-only, for thirty minutes.
 *
 *   POST { tenantId, reason }  → { ok, next: "/" }
 *
 * The browser's session cookie is switched to the view session; the staff
 * member's own session is kept and given back by /api/view-as/exit. Everything
 * that makes the view read-only is in lib/staff/view-as.ts and server.ts.
 * Belline staff only.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!isBellineStaff(auth.user)) return NextResponse.json({ error: "Belline staff only." }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { tenantId?: unknown; reason?: unknown };
  const jar = await cookies();
  const out = await startViewAs(
    auth.user,
    jar.get(SESSION_COOKIE)?.value,
    typeof body.tenantId === "string" ? body.tenantId : "",
    typeof body.reason === "string" ? body.reason : "",
    { userAgent: request.headers.get("user-agent") ?? undefined },
  );
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });

  const response = NextResponse.json({ ok: true, next: "/" });
  response.cookies.set(SESSION_COOKIE, out.session.id, sessionCookieOptions(VIEW_AS_MINUTES * 60));
  return response;
}
