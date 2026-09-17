import { seedIfEmpty } from "@/lib/seed";
import { serveLogo } from "@/lib/logo-store";

export const dynamic = "force-dynamic";

/**
 * A venue's logo, for anybody.
 *
 * Public on purpose: it is drawn on the venue's own website and in its chat
 * window, where nobody is signed in. The key is the logo's own random id, new
 * on every upload, so it names a picture and nothing else — not the venue, not
 * its widget key — and a replaced logo is a new URL that can be cached for a
 * year. Headers (nosniff, a sandboxing CSP, cross-origin CORP) are set in
 * lib/logo.ts `logoHeaders`.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  seedIfEmpty();
  return serveLogo(key);
}
