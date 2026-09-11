import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Which build is actually running.
 *
 * Written after a deploy went out and there was no way to tell from outside
 * whether it had landed. Asset hashes are not the answer: a change that is
 * entirely server-side leaves the client bundle byte-identical, so the page
 * looks unchanged whether the deploy succeeded, failed, or is still building.
 *
 * Unauthenticated on purpose — a deploy check nobody can run without a session
 * is a deploy check nobody runs. It reveals a commit SHA and a boot time,
 * which tell an attacker nothing they could not learn from the public repo,
 * and no vendor keys, config or counts are included.
 */

const BOOTED_AT = new Date().toISOString();

/**
 * Railway sets RAILWAY_GIT_COMMIT_SHA on every build. The others are there so
 * this keeps working if the host changes underneath it.
 */
function commit(): string {
  return (
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_COMMIT_SHA ??
    "unknown"
  );
}

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      commit: commit().slice(0, 12),
      bootedAt: BOOTED_AT,
      uptimeSeconds: Math.round(process.uptime()),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
