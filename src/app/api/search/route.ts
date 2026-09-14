import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { searchEverything } from "@/lib/search";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return NextResponse.json({ hits: searchEverything(auth.user, q.slice(0, 80)) });
}
