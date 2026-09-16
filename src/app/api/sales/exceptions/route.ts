import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { isExceptionKind, listExceptions, updateException, type ExceptionFilter } from "@/lib/exceptions";

export const dynamic = "force-dynamic";

/**
 * The staff exceptions queue.
 *
 * Route handlers are not covered by the `(internal)` layout's guard, so this
 * checks for itself: Belline staff only, never an owner of their own tenant.
 */

async function staff() {
  const auth = await requireApiUser();
  if (auth.response) return { response: auth.response };
  if (!isBellineStaff(auth.user)) return { response: NextResponse.json({ error: "Not permitted." }, { status: 403 }) };
  return { user: auth.user };
}

export async function GET(request: Request) {
  const who = await staff();
  if (who.response) return who.response;
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const kind = url.searchParams.get("kind");
  const filter: ExceptionFilter = {
    status: status === "open" || status === "waiting_customer" || status === "resolved" || status === "all" ? status : "unresolved",
    ...(isExceptionKind(kind) ? { kind } : {}),
  };
  return NextResponse.json({ exceptions: listExceptions(filter) });
}

/** `{ id, action: "resolve", note, minutes }` or `{ id, action: "waiting" }`. */
export async function POST(request: Request) {
  const who = await staff();
  if (who.response) return who.response;
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; action?: unknown; note?: unknown; minutes?: unknown };
  const exceptionId = typeof body.id === "string" ? body.id : "";
  if (!exceptionId) return NextResponse.json({ error: "Which exception?" }, { status: 400 });

  const by = who.user.name || who.user.email;
  const result =
    body.action === "resolve"
      ? updateException(exceptionId, { kind: "resolve", note: body.note, minutes: body.minutes, by })
      : body.action === "waiting"
        ? updateException(exceptionId, { kind: "waiting", by })
        : ({ ok: false, status: 400, error: "Unknown action." } as const);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, exception: result.exception });
}
