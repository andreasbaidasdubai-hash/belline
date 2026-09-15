import { NextResponse } from "next/server";
import { flag } from "@/lib/flags";

export const dynamic = "force-dynamic";

/**
 * Stripe's hosted checkout, played locally. `FLAG_STUBS=on` only.
 *
 * The folder is `%5F%5Fstub` because Next treats a folder starting with an
 * underscore as private; the encoded name serves `/__stub/stripe/checkout`.
 *
 * Opening it "pays": it posts a signed `checkout.session.completed` to our own
 * webhook twice — the second is Stripe's redelivery, which must change
 * nothing — and then sends the browser to the session's success URL, as
 * Stripe would. The webhook is what makes the plan real, here as in production.
 */
export async function GET(req: Request) {
  if (!flag("stubs")) return new NextResponse("Not found", { status: 404 });
  const { readStubCheckoutSession, signWebhook, stubCompletedEvent } = await import("@/lib/testing/stubs");

  const session = readStubCheckoutSession(new URL(req.url).searchParams.get("session") ?? "");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!session || !secret) return new NextResponse("No such stub session", { status: 404 });

  // This machine's own port, never an address taken from the request.
  const local = `http://localhost:${process.env.PORT ?? 3000}`;
  const payload = stubCompletedEvent(session);
  const statuses: number[] = [];
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${local}/api/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signWebhook(payload, secret) },
      body: payload,
    });
    statuses.push(res.status);
  }
  console.log(`[stubs] stripe checkout ${session.id}: webhook ${statuses.join(", ")}`);

  // The checkout route wrote an absolute localhost URL under stubs.
  const success = (session.params as { success_url?: string }).success_url ?? `${local}/billing`;
  return NextResponse.redirect(success, 303);
}
