import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import {
  cancelAtPeriodEnd,
  changePlan,
  confirmEmail,
  extendTrial,
  resetLinkFor,
  setTrialSuspended,
  setUserDisabled,
  updateBusinessDetails,
} from "@/lib/staff/customers";

export const dynamic = "force-dynamic";

/**
 * Actions on one customer from the staff console.
 *
 *   POST { tenantId, action: "details", name, category, email, phone }
 *   POST { tenantId, action: "extend_trial", locationId, days, reason }
 *   POST { tenantId, action: "change_plan", locationId, productId, reason }
 *   POST { tenantId, action: "suspend" | "reactivate", reason }
 *   POST { tenantId, action: "cancel", locationId, reason }
 *   POST { tenantId, action: "reset_link", userId }        → { link, minutes }
 *   POST { tenantId, action: "confirm_email", userId }
 *   POST { tenantId, action: "disable_user" | "enable_user", userId, reason }
 *
 * Nothing here charges a card or sends an email. Belline staff only, checked
 * here and again inside every action; every change is audited there.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!isBellineStaff(auth.user)) return NextResponse.json({ error: "Belline staff only." }, { status: 403 });

  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const tenantId = typeof b.tenantId === "string" ? b.tenantId : "";
  const me = auth.user;

  switch (b.action) {
    case "details":
      return answer(await updateBusinessDetails(me, tenantId, b));
    case "extend_trial":
      return answer(await extendTrial(me, tenantId, b.locationId, b.days, b.reason));
    case "change_plan":
      return answer(await changePlan(me, tenantId, b.locationId, b.productId, b.reason));
    case "suspend":
    case "reactivate":
      return answer(await setTrialSuspended(me, tenantId, b.action === "suspend", b.reason));
    case "cancel":
      return answer(await cancelAtPeriodEnd(me, tenantId, b.locationId, b.reason));
    case "reset_link": {
      const out = await resetLinkFor(me, tenantId, b.userId);
      if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
      // The link signs somebody in to set a password: never cached anywhere.
      return NextResponse.json({ ok: true, link: out.value.link, minutes: out.value.minutes }, { headers: { "Cache-Control": "no-store" } });
    }
    case "confirm_email":
      return answer(await confirmEmail(me, tenantId, b.userId));
    case "disable_user":
    case "enable_user":
      return answer(await setUserDisabled(me, tenantId, b.userId, b.action === "disable_user", b.reason));
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}

function answer(out: { ok: true } | { ok: false; status: number; error: string }) {
  return out.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: out.error }, { status: out.status });
}
