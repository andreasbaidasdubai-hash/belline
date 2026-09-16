import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { isConfigured, one } from "@/lib/sales/db/client";

export const dynamic = "force-dynamic";

/**
 * Is the sales engine actually wired up in this environment?
 *
 * Every database failure in the sales code is deliberately silent — a page
 * that carries a prospect's demo must not break because our own reporting
 * database is unreachable, and the voice product must not care at all. That is
 * the right behaviour and it makes one question impossible to answer from
 * outside: *is it connected?* This answers it.
 *
 * Reachable without signing in, because uptime monitoring cannot sign in —
 * but only as far as liveness. It used to answer a stranger with how many
 * agents we run, how many leads are in the pipeline and how many demos are
 * live: the shape and size of the business, handed to anybody who guessed the
 * URL. Those are staff-only now, and are not even queried for anyone else.
 *
 * What everyone still gets is three booleans and a latency — no connection
 * string, no host, no credentials, no customer or prospect data — which is all
 * a monitor needs.
 */
export async function GET() {
  const started = Date.now();

  if (!isConfigured()) {
    return NextResponse.json(
      { ok: false, configured: false, reachable: false, reason: "DATABASE_URL is not set" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Asked after the answer above, so a monitor with no session and no
  // database still gets a reply without ever reaching the auth code.
  const auth = await requireApiUser();
  const staff = Boolean(auth.user && isBellineStaff(auth.user));

  try {
    // The probe a monitor needs. The counts are a second query rather than a
    // wider first one, so an anonymous request never runs them at all.
    await one<{ ok: number }>(`select 1 as ok`);
    const counts = staff
      ? await one<{ agents: number; leads: number; demos: number }>(
          `select
             (select count(*)::int from sales.agent)                        as agents,
             (select count(*)::int from sales.lead)                         as leads,
             (select count(*)::int from sales.demo where expires_at > now()) as demos`,
        )
      : null;
    return NextResponse.json(
      {
        ok: true,
        configured: true,
        reachable: true,
        ...(counts
          ? { agents: counts.agents, leads: counts.leads, liveDemos: counts.demos }
          : {}),
        latencyMs: Date.now() - started,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // The message, not the stack, and never the connection string: this is a
    // public endpoint and the error text can name the host it failed to reach.
    const message = (err as Error).message.slice(0, 120);
    const safe = /password|postgres(ql)?:\/\//i.test(message)
      ? "connection failed"
      : message;
    return NextResponse.json(
      {
        ok: false,
        configured: true,
        reachable: false,
        reason: safe,
        latencyMs: Date.now() - started,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
