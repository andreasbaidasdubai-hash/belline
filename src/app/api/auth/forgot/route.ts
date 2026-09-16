import { NextResponse } from "next/server";
import { padTo, requestPasswordReset, resetMode, resetRequestedMessage } from "@/lib/auth-reset";
import { clientKey } from "@/lib/onboarding/limit";
import { seedIfEmpty } from "@/lib/seed";

export const dynamic = "force-dynamic";

/**
 * Forgot password.
 *
 * Always 200 with the same sentence, after the same minimum time, whether the
 * address has an account, has none, or has asked too often. The email (or the
 * team's ticket, with email off) is written in the background so its latency
 * cannot tell anybody which it was. See lib/auth-reset.ts.
 */
export async function POST(request: Request) {
  seedIfEmpty();
  const started = Date.now();
  const body = (await request.json().catch(() => ({}))) as { email?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().slice(0, 254) : "";
  if (!email) {
    return NextResponse.json({ error: "Enter the email address you sign in with." }, { status: 400 });
  }

  const out = requestPasswordReset({ email, peer: clientKey(request.headers) });
  void out.work;
  await padTo(started);
  return NextResponse.json({ ok: true, message: resetRequestedMessage(resetMode()) });
}
