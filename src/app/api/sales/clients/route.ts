import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { bookAsCsv, clientBook } from "@/lib/sales/clients";
import { tryAudit } from "@/lib/sales/db/repo/activity";

export const dynamic = "force-dynamic";

/** The client book as a spreadsheet. Owner-only, like the page. */
export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!isBellineStaff(auth.user)) {
    return NextResponse.json({ error: "Owner only." }, { status: 403 });
  }
  seedIfEmpty();
  const rows = clientBook();
  const stamp = new Date().toISOString().slice(0, 10);

  // Every client, what they pay and what they use, leaving in one file. It is
  // the most sensitive thing the console can hand out, and it went out on a
  // GET that left no trace of who took it or when.
  await tryAudit({
    actor: `user:${auth.user.id}`,
    action: "client_book_exported",
    entity: "client_book",
    entityId: stamp,
    after: { venues: rows.length, format: "csv" },
  });

  return new NextResponse(bookAsCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="belline-clients-${stamp}.csv"`,
    },
  });
}
