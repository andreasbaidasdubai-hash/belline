/**
 * Stop hearing from us, without the email in front of you.
 *
 * `/u/<token>` is the one-click link in a footer, and it is the best route
 * there is: it knows who is asking, so it can act without being told. This
 * page is for the person who no longer has that email — who typed
 * `trybelline.com` into a browser to find out who wrote to them, landed on the
 * sender page, and followed the link that said "make it stop".
 *
 * It does not pretend to have stopped anything. It cannot: nobody has told it
 * who is asking, and a page that says "you're unsubscribed" to a visitor it
 * has never heard of is a lie that also loses the request. What it does is
 * name the two routes that genuinely work and are genuinely permanent — the
 * one-click link, and a reply or a message saying no — and get out of the way.
 *
 * Deliberately no form. An address box on an unauthenticated page is a way to
 * suppress somebody else's business, and a box that then has to be confirmed
 * by email is exactly the "go and find an email" this page exists to avoid.
 *
 * Reached on every hostname the app answers, which is what matters: the four
 * sending domains are served by this same process (src/lib/marketing.ts), so
 * the link on a sender page never leaves the domain the mail came from.
 */

import { NextResponse } from "next/server";
import { legalIdentity } from "@/lib/legal/identity";
import { stopPage } from "./shell";

export const dynamic = "force-dynamic";

export async function GET() {
  const email = legalIdentity().email || "hello@belline.ai";
  const html = stopPage({
    heading: "Make it stop.",
    body:
      `<p>Belline sends a small amount of cold business email, and you can end it ` +
      `permanently in one step. You do not need to explain yourself and we will not ask why.</p>` +
      `<p><strong>If you still have the email:</strong> the unsubscribe link in its footer is one ` +
      `click, no form and no sign-in.</p>` +
      `<p><strong>If you do not:</strong> reply to any message from us with <strong>no thanks</strong>, ` +
      `or write those two words to <a href="mailto:${email}?subject=no%20thanks">${email}</a>. ` +
      `Either one suppresses your whole business — every address at it, not only the one we used — ` +
      `and it is permanent.</p>` +
      `<p>A reply of any kind also stops the sequence immediately, whatever it says.</p>`,
  });
  return new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
