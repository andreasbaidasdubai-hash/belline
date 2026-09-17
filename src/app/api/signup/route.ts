import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { signUp } from "@/lib/onboarding";
import { clientKey, createSignupLimiter } from "@/lib/onboarding/limit";
import { seedIfEmpty } from "@/lib/seed";
import { SESSION_COOKIE, login } from "@/lib/auth";
import { sessionCookieOptions } from "@/lib/auth-server";
import { DEVICE_COOKIE, screenSignup } from "@/lib/abuse/review";
import { sendVerificationCode } from "@/lib/email-verify";

export const dynamic = "force-dynamic";

/**
 * Create an account.
 *
 * The one route on this server that is public, unauthenticated and writes. It
 * exists because the alternative — a form that emails a salesperson — is four
 * humans in the loop for a product priced at one, and because "Get Belline"
 * is not an honest button until this works.
 *
 * Being public is the whole point and also the whole risk, so:
 *
 *   Rate limited by address (onboarding/limit.ts). Accounts created are
 *   counted strictly; refused attempts get a far higher ceiling, so a person
 *   fighting the password rule is never locked out by it.
 *
 *   Screened for trial abuse (abuse/review.ts): a throwaway mailbox is
 *   refused, and so is a fourth trial in a month from one network or a third
 *   from one browser (the `belline_device` cookie), each recorded for staff
 *   review in the sales console.
 *
 *   Validated in the library, not here. `signUp` checks every field and
 *   returns which one failed, so the browser can put the message next to the
 *   right input rather than at the top of the page.
 *
 *   Terms recorded. The box on the form is required here too, and `signUp`
 *   stores the versions it agreed to.
 *
 *   Signed in on success, with the email still to confirm. The owner lands on
 *   /verify with a 6-digit code on its way (email-verify.ts). Nothing that
 *   costs Belline money runs until they type it; the dashboard and setting up
 *   by hand do not wait for it.
 */

const limiter = createSignupLimiter();

const DEVICE = new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE}=([A-Za-z0-9_-]{16,64})`);

export async function POST(req: Request) {
  seedIfEmpty();

  const key = clientKey(req.headers);
  if (limiter.blocked(key)) {
    return NextResponse.json(
      { error: "Too many signups from here just now. Try again in an hour." },
      { status: 429 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Send JSON." }, { status: 400 });
  }

  // The browser's own id, set on its first signup and kept a year. Clearing
  // cookies resets it, so it is one cheap signal among several, never proof.
  const known = DEVICE.exec(req.headers.get("cookie") ?? "")?.[1];
  const device = known ?? randomBytes(18).toString("base64url");

  if (body.acceptTerms !== true) {
    limiter.record(key, false);
    return NextResponse.json(
      { field: "terms", error: "Tick the box to agree to the Terms and Privacy policy." },
      { status: 422 },
    );
  }

  const screen = screenSignup({ ip: key, device: known, email: String(body.email ?? "").trim().toLowerCase() });
  if (!screen.ok) {
    limiter.record(key, false);
    return NextResponse.json({ error: screen.error, signIn: "/login" }, { status: 429 });
  }

  let result: Awaited<ReturnType<typeof signUp>>;
  try {
    result = await signUp({
      businessName: String(body.businessName ?? ""),
      email: String(body.email ?? ""),
      password: String(body.password ?? ""),
      // What they picked from the checkout's list, never an engine. The
      // engine it runs on is worked out in signUp, so a trade key such as
      // "garage" can never arrive here dressed as a `vertical`.
      trade: body.trade === undefined ? undefined : String(body.trade),
      // No timezone from the browser: the market decides it.
      // What they had picked on the checkout page. Validated against the
      // catalogue in signUp; anything else falls back to the trial's own bundle.
      products: Array.isArray(body.products) ? body.products : undefined,
      market: body.market ? String(body.market) : undefined,
      emailConfirmed: body.emailConfirmed === true,
      acceptedTerms: true,
      selfServe: { ip: key, device },
    });
  } catch (err) {
    // signUp has already removed anything it wrote. The detail is for us.
    console.error("[signup] failed:", err);
    limiter.record(key, false);
    return NextResponse.json(
      { error: "We could not set up your account. Nothing was saved. Try again in a minute." },
      { status: 500 },
    );
  }

  if (!result.ok) {
    limiter.record(key, false);
    // 422 rather than 400: the request was well formed, the contents were not.
    return NextResponse.json(
      { field: result.field, error: result.error, didYouMean: result.didYouMean, signIn: result.signIn },
      { status: 422 },
    );
  }
  limiter.record(key, true);

  // The code (or, with email off, the team's ticket) goes out in the
  // background; the next screen says which.
  const sent = sendVerificationCode(result.user.id);
  if (sent.ok) void sent.delivery;

  const session = login(
    result.user.email,
    String(body.password),
    req.headers.get("user-agent") ?? undefined,
  );

  const response = NextResponse.json({
    ok: true,
    locationId: result.location.id,
    next: "/verify",
  });

  if (session.ok) {
    const maxAge = Math.floor((Date.parse(session.session.expiresAt) - Date.now()) / 1000);
    response.cookies.set(SESSION_COOKIE, session.session.id, sessionCookieOptions(maxAge));
  }
  response.cookies.set(DEVICE_COOKIE, device, sessionCookieOptions(365 * 24 * 3600));

  return response;
}
