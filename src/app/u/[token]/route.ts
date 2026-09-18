/**
 * One-click unsubscribe.
 *
 * Public, unauthenticated, and deliberately the shortest path in the codebase:
 * a token in, a suppression row out, a sentence back. No login, no "are you
 * sure", no preference centre, no form asking why. Every extra step here is a
 * step between somebody who wants to be left alone and being left alone, and
 * the ones who give up half way through are exactly the ones who press the
 * spam button instead.
 *
 * Both verbs are handled. GET is the link in the footer; POST is what Gmail
 * and Outlook send when the recipient uses the provider's own unsubscribe
 * button, per RFC 8058, and that button only appears because the message
 * carries `List-Unsubscribe-Post`.
 *
 * Suppression is per company, not per address, and permanent. See
 * `sending/unsubscribe.ts` for why.
 */

import { NextResponse } from "next/server";
import { verifyUnsubscribeToken } from "@/lib/sales/sending/unsubscribe";
import { sendingStore } from "@/lib/sales/sending/store";
import { suppressCompany } from "@/lib/sales/sending/replies";
import { halt, blankState } from "@/lib/sales/sending/sequence";

export const dynamic = "force-dynamic";

const PAGE = (heading: string, body: string, lang = "en") => `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${heading}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; display: grid; place-items: center; min-height: 100vh; padding: 24px;
         background: #fbfaf8; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #131312; color: #f2f1ef; } }
  main { max-width: 34rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .5rem; font-weight: 600; }
  p { margin: 0; opacity: .85; }
</style></head>
<body><main><h1>${heading}</h1><p>${body}</p></main></body></html>`;

async function act(token: string): Promise<{ ok: boolean; lang: string }> {
  const claim = verifyUnsubscribeToken(token);
  // An unreadable token is still answered with "you are unsubscribed". Telling
  // a stranger that their token is invalid is both useless to them and a way
  // to probe what we hold.
  if (!claim) return { ok: false, lang: "en" };

  const store = sendingStore();
  const items = await store.listItems({ limit: 2000 });
  const item = items.find((i) => i.id === claim.itemId) ?? null;
  const lang = item?.language ?? "en";

  await suppressCompany({
    email: item?.toAddress ?? null,
    companyId: item?.companyId ?? claim.companyId,
    reason: "opt_out",
    by: "recipient",
  }, store);

  if (item) {
    const state = (await store.getSequence(item.leadId)) ?? blankState(item.leadId, item.companyId, item.countryCode);
    await store.upsertSequence(halt(state, "unsubscribed", new Date()));
    for (const queued of await store.listItems({ leadId: item.leadId, status: ["planned", "queued"] })) {
      await store.updateItem(queued.id, { status: "cancelled", blockedReason: "stopped: they unsubscribed" });
    }
    await store.addEvent({
      mailboxId: item.mailboxId,
      domainId: null,
      leadId: item.leadId,
      itemId: item.id,
      kind: "unsubscribe",
      detail: { via: "one-click" },
    });
  }

  return { ok: true, lang };
}

function page(lang: string): string {
  return lang.startsWith("de")
    ? PAGE(
        "Sie wurden ausgetragen.",
        "Sie erhalten keine weiteren Nachrichten von uns — weder an diese noch an eine andere Adresse Ihres Unternehmens. Dieser Eintrag wird nicht gelöscht.",
        "de",
      )
    : PAGE(
        "You're unsubscribed.",
        "You will not hear from us again — not at this address and not at any other address at your business. This is permanent; nothing needs doing at your end.",
      );
}

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { lang } = await act((await params).token);
  return new NextResponse(page(lang), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** RFC 8058: the provider's own button. The body is ignored; the token is all. */
export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  await act((await params).token);
  return new NextResponse(null, { status: 200, headers: { "cache-control": "no-store" } });
}
