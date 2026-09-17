import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { ensureStubProspect } from "@/lib/sales/video-demo/fixture";
import { requestDemoOrigin } from "@/app/(internal)/sales/leads/demo-origin";
import {
  createVideoDemo,
  draftForLink,
  linkView,
  previewVideoDemo,
  recordDemoEvent,
  revokeVideoDemo,
} from "@/lib/sales/video-demo/service";
import { demoStore } from "@/lib/sales/video-demo/store";

export const dynamic = "force-dynamic";

/**
 * Personalised video demos, for Belline staff.
 *
 *   GET  ?leadId=12                     the lead's links, with status and counters
 *   POST { action: "preview", leadId, opening? }   the opening, its checks, the briefing
 *   POST { action: "create", leadId, opening, ttlDays? }
 *   POST { action: "revoke", id }
 *   POST { action: "draft", id }        the email draft; writes nothing
 *   POST { action: "prepared", id }     staff copied the draft or opened it in their mail app
 *
 * Nothing here sends anything. "prepared" records that a person took the
 * draft to their own mail app, which is the only way it leaves.
 */

async function staff() {
  const auth = await requireApiUser();
  if (auth.response) return { response: auth.response };
  if (!isBellineStaff(auth.user)) return { response: NextResponse.json({ error: "Not permitted." }, { status: 403 }) };
  return { user: auth.user };
}

/**
 * The origin every demo link in a draft is built on.
 *
 * Never the request's own address: behind Railway's proxy the handler is
 * addressed to the container, so the links staff copied into an outreach
 * email would have pointed the prospect at `localhost:3000` (check:origin,
 * src/lib/origin.ts). `requestDemoOrigin` is the one answer to this question
 * the console already uses — `PUBLIC_ORIGIN` where it is set, the forwarded
 * host for a local run — and it says it cannot rather than guess: a link to
 * the wrong site is worse than no link at all.
 */
async function originOf(): Promise<{ origin: string; response?: undefined } | { origin?: undefined; response: NextResponse }> {
  const out = await requestDemoOrigin();
  if (!out.ok) return { response: NextResponse.json({ error: out.error }, { status: 500 }) };
  return { origin: out.origin };
}

export async function GET(req: Request) {
  const who = await staff();
  if (who.response) return who.response;
  await ensureStubProspect();
  const leadId = Number(new URL(req.url).searchParams.get("leadId"));
  const links = await demoStore().list(Number.isFinite(leadId) && leadId > 0 ? { leadId } : {});
  const where = await originOf();
  if (where.response) return where.response;
  const origin = where.origin;
  return NextResponse.json({ links: links.map((l) => linkView(l, origin)) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const who = await staff();
  if (who.response) return who.response;
  await ensureStubProspect();
  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    leadId?: unknown;
    opening?: unknown;
    ttlDays?: unknown;
    id?: unknown;
  };
  const actor = `user:${who.user.id}`;
  const where = await originOf();
  if (where.response) return where.response;
  const origin = where.origin;
  const leadId = Number(body.leadId);
  const opening = typeof body.opening === "string" ? body.opening.slice(0, 2000) : undefined;
  const id = typeof body.id === "string" ? body.id : "";

  switch (body.action) {
    case "preview": {
      const out = await previewVideoDemo(leadId, opening);
      if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
      return NextResponse.json(out);
    }
    case "create": {
      const out = await createVideoDemo({
        leadId,
        opening,
        ttlDays: typeof body.ttlDays === "number" ? body.ttlDays : undefined,
        actor,
        origin,
      });
      if (!out.ok) return NextResponse.json({ error: out.error, problems: out.problems ?? [] }, { status: out.status });
      return NextResponse.json({ ok: true, link: linkView(out.link, origin), draft: await draftForLink(out.link.id, origin) });
    }
    case "revoke": {
      const out = await revokeVideoDemo(id, actor);
      if (!out) return NextResponse.json({ error: "Not found, or already revoked." }, { status: 404 });
      return NextResponse.json({ ok: true, link: linkView(out, origin) });
    }
    case "draft": {
      const draft = await draftForLink(id, origin);
      if (!draft) return NextResponse.json({ error: "Not found." }, { status: 404 });
      return NextResponse.json({ ok: true, draft });
    }
    case "prepared": {
      const draft = await draftForLink(id, origin);
      if (!draft) return NextResponse.json({ error: "Not found." }, { status: 404 });
      if (draft.blocked.length) return NextResponse.json({ error: draft.blocked[0], blocked: draft.blocked }, { status: 409 });
      await recordDemoEvent(id, "email_prepared", { actor });
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}
