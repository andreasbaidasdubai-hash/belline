import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import { getLocation } from "@/lib/store";
import { exportCsv, type ExportKind } from "@/lib/reports";

export const dynamic = "force-dynamic";

const KINDS: ExportKind[] = ["bookings", "calls", "customers"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Bookings, calls or customers for a date range, as a spreadsheet. Managers and owners. */
export async function GET(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const url = new URL(req.url);
  const location = getLocation(url.searchParams.get("loc") ?? "");
  if (!location || !canSeeLocation(auth.user, location.id) || auth.user.role === "staff") {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }
  const kind = (KINDS.includes(url.searchParams.get("kind") as ExportKind) ? url.searchParams.get("kind") : "bookings") as ExportKind;
  const from = DATE.test(url.searchParams.get("from") ?? "") ? url.searchParams.get("from")! : "2000-01-01";
  const to = DATE.test(url.searchParams.get("to") ?? "") ? url.searchParams.get("to")! : "2999-12-31";
  const safeName = location.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return new NextResponse(exportCsv(location, kind, from, to), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${safeName}-${kind}-${from}-to-${to}.csv"`,
    },
  });
}
