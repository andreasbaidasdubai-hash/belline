import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth-server";
import { setUsagePolicyRequest } from "@/lib/billing/usage-policy";

export const dynamic = "force-dynamic";

/**
 * Choose what happens at 100% of an allowance.
 *
 * Owner only, and only for a venue of the owner's own tenant — the same rule
 * as the billing portal. Every check lives in `setUsagePolicyRequest`, which
 * scripts/check-usage-policy.ts exercises directly; this is only the HTTP
 * wrapper. Nothing here charges anything: it records a choice.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const result = setUsagePolicyRequest(user, body);
  return NextResponse.json(result.body, { status: result.status });
}
