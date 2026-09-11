import { NextResponse } from "next/server";
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
 * Public, because it says nothing a stranger could use: three booleans, a row
 * count and a latency. No connection string, no host, no credentials, no
 * customer or prospect data. The alternative — putting it behind the owner
 * login — means it cannot be used by uptime monitoring, which is most of the
 * point.
 */
export async function GET() {
  const started = Date.now();

  if (!isConfigured()) {
    return NextResponse.json(
      { ok: false, configured: false, reachable: false, reason: "DATABASE_URL is not set" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const row = await one<{ agents: number; leads: number; demos: number }>(
      `select
         (select count(*)::int from sales.agent)                        as agents,
         (select count(*)::int from sales.lead)                         as leads,
         (select count(*)::int from sales.demo where expires_at > now()) as demos`,
    );
    return NextResponse.json(
      {
        ok: true,
        configured: true,
        reachable: true,
        agents: row?.agents ?? 0,
        leads: row?.leads ?? 0,
        liveDemos: row?.demos ?? 0,
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
