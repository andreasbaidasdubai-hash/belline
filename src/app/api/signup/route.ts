import { NextResponse } from "next/server";
import { signUp } from "@/lib/onboarding";
import { clientKey, createSignupLimiter } from "@/lib/onboarding/limit";
import { seedIfEmpty } from "@/lib/seed";
import { SESSION_COOKIE, login } from "@/lib/auth";
import { sessionCookieOptions } from "@/lib/auth-server";
import type { Vertical } from "@/lib/types";

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
 *   Validated in the library, not here. `signUp` checks every field and
 *   returns which one failed, so the browser can put the message next to the
 *   right input rather than at the top of the page.
 *
 *   Terms recorded. The box on the form is required here too, and `signUp`
 *   stores the versions it agreed to.
 *
 *   Signed in on success. A customer who has just typed a password should not
 *   be asked for it again on the next screen.
 */

const limiter = createSignupLimiter();

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

  if (body.acceptTerms !== true) {
    limiter.record(key, false);
    return NextResponse.json(
      { field: "terms", error: "Tick the box to agree to the Terms and Privacy policy." },
      { status: 422 },
    );
  }

  let result: Awaited<ReturnType<typeof signUp>>;
  try {
    result = await signUp({
      businessName: String(body.businessName ?? ""),
      email: String(body.email ?? ""),
      password: String(body.password ?? ""),
      vertical: String(body.vertical ?? "") as Vertical | "",
      // No timezone from the browser: the market decides it.
      // What they had picked on the checkout page. Validated against the
      // catalogue in signUp; anything else falls back to the trial's own bundle.
      products: Array.isArray(body.products) ? body.products : undefined,
      market: body.market ? String(body.market) : undefined,
      emailConfirmed: body.emailConfirmed === true,
      acceptedTerms: true,
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

  // Straight in. No confirmation email standing between somebody who has just
  // paid us attention and the thing they came for.
  const session = login(
    result.user.email,
    String(body.password),
    req.headers.get("user-agent") ?? undefined,
  );

  const response = NextResponse.json({
    ok: true,
    locationId: result.location.id,
    next: "/setup",
  });

  if (session.ok) {
    const maxAge = Math.floor((Date.parse(session.session.expiresAt) - Date.now()) / 1000);
    response.cookies.set(SESSION_COOKIE, session.session.id, sessionCookieOptions(maxAge));
  }

  return response;
}
