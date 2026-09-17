import { headers } from "next/headers";
import { demoOrigin } from "@/lib/sales/video-demo/service";

/**
 * The origin video-demo links point at, for a console page: `PUBLIC_ORIGIN`
 * where set, else the host the console was opened on (a local run). Returns
 * the error text when it cannot be used: links to the wrong site are worse
 * than none (outreach/templates.ts).
 */
export async function requestDemoOrigin(): Promise<{ ok: true; origin: string } | { ok: false; error: string }> {
  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "localhost:3000";
  const proto = head.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  try {
    return { ok: true, origin: demoOrigin(`${proto}://${host}`) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "PUBLIC_ORIGIN is not usable." };
  }
}
