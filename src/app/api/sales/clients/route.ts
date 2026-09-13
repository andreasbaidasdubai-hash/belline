import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { bookAsCsv, clientBook } from "@/lib/sales/clients";

export const dynamic = "force-dynamic";

/** The client book as a spreadsheet. Owner-only, like the page. */
export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!isBellineStaff(auth.user)) {
    return NextResponse.json({ error: "Owner only." }, { status: 403 });
  }
  seedIfEmpty();
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(bookAsCsv(clientBook()), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="belline-clients-${stamp}.csv"`,
    },
  });
}
