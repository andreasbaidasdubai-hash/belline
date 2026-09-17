import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { changeUnverifiedEmail, checkVerificationCode, sendVerificationCode, verifyMode } from "@/lib/email-verify";

export const dynamic = "force-dynamic";

/**
 * Confirming the owner's email address, signed in.
 *
 *   POST { action: "check", code }   the 6-digit code from the email
 *   POST { action: "resend" }        a new code (once a minute, five an hour)
 *   POST { action: "change", email } a corrected address, and a code to it
 *
 * Every limit lives in lib/email-verify.ts, stored on the user.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const user = auth.user;
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; code?: unknown; email?: unknown };

  if (body.action === "check") {
    const out = checkVerificationCode(user.id, String(body.code ?? ""));
    if (!out.ok) return NextResponse.json({ error: out.error, field: out.field }, { status: out.status });
    return NextResponse.json({ ok: true, next: "/setup" });
  }

  if (body.action === "resend" || body.action === "change") {
    const out =
      body.action === "resend" ? sendVerificationCode(user.id) : changeUnverifiedEmail(user.id, String(body.email ?? "").slice(0, 254));
    if (!out.ok) {
      return NextResponse.json(
        { error: out.error, field: "field" in out ? out.field : undefined, retryAfterSeconds: "retryAfterSeconds" in out ? out.retryAfterSeconds : undefined },
        { status: out.status },
      );
    }
    void out.delivery;
    return NextResponse.json({
      ok: true,
      mode: verifyMode(),
      message:
        out.mode === "email"
          ? "A new code is on its way. It works for 15 minutes."
          : "The Belline team has been asked to confirm your address.",
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
