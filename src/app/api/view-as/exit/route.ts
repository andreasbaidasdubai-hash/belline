import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { sessionCookieOptions } from "@/lib/auth-server";
import { SESSION_COOKIE } from "@/lib/auth";
import { getSession } from "@/lib/store";
import { exitViewAs } from "@/lib/staff/view-as";

export const dynamic = "force-dynamic";

/** A relative redirect, so the host behind a proxy never leaks into Location. */
function goTo(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

/**
 * Leave "View as customer" and go back to the staff console.
 *
 * GET, because it is a link in the banner and the one address server.ts lets
 * a view session reach with writes allowed. It can only ever end a view: on a
 * session that is not one it changes nothing and sends the browser home. The
 * staff member's own session goes back in the cookie when it is still valid;
 * otherwise they sign in again.
 */
export async function GET() {
  const jar = await cookies();
  const current = jar.get(SESSION_COOKIE)?.value;
  const session = current ? getSession(current) : undefined;
  if (!session?.viewAs) return goTo("/");

  const tenantId = session.viewAs.tenantId;
  const { returnSessionId } = await exitViewAs(current);
  if (!returnSessionId) {
    const response = goTo("/login");
    response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
    return response;
  }
  const back = getSession(returnSessionId)!;
  const response = goTo(`/sales/customers/${encodeURIComponent(tenantId)}`);
  response.cookies.set(SESSION_COOKIE, back.id, sessionCookieOptions(Math.floor((Date.parse(back.expiresAt) - Date.now()) / 1000)));
  return response;
}
