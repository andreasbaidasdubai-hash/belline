import { assertPublicUrl } from "../prospect";

/**
 * Which website builder a venue uses, and the exact steps to add the widget.
 *
 * Detected from the site's own HTML — the fingerprints every builder leaves in
 * its asset URLs and meta tags — so the owner is shown their steps, not a
 * general explanation of what a script tag is. And checked afterwards by
 * fetching the site again and looking for the snippet, so "is it on?" has a
 * yes or no rather than a shrug.
 */

export type Platform = "squarespace" | "wix" | "wordpress" | "shopify" | "webflow" | "godaddy" | "custom";

export function detectPlatform(html: string): Platform {
  const h = html.slice(0, 300_000).toLowerCase();
  if (h.includes("static1.squarespace.com") || h.includes("squarespace-cdn") || h.includes("<!-- this is squarespace")) return "squarespace";
  if (h.includes("static.wixstatic.com") || h.includes("wix.com website builder") || h.includes("_wixcssimports")) return "wix";
  if (h.includes("cdn.shopify.com") || h.includes("shopify.theme")) return "shopify";
  if (h.includes("data-wf-page") || h.includes("webflow.css") || h.includes("assets.website-files.com")) return "webflow";
  if (h.includes("img1.wsimg.com") || h.includes("godaddy website builder")) return "godaddy";
  if (h.includes("/wp-content/") || h.includes("/wp-includes/") || h.includes('name="generator" content="wordpress')) return "wordpress";
  return "custom";
}

export const INSTALL_STEPS: Record<Platform, { name: string; steps: string[]; note?: string }> = {
  squarespace: {
    name: "Squarespace",
    steps: [
      "Open your site's settings and find Code Injection (Website → Website Tools → Code Injection, or Settings → Advanced → Code Injection on older sites).",
      "Paste the snippet into the Footer box.",
      "Save. The buttons appear on every page.",
    ],
    note: "Code Injection needs a Squarespace plan that includes it.",
  },
  wix: {
    name: "Wix",
    steps: [
      "In your site dashboard, go to Settings → Custom Code (under Advanced).",
      "Click Add Custom Code and paste the snippet.",
      "Choose All pages, place it in Body – end, and click Apply.",
    ],
    note: "Wix only runs custom code on a premium plan with a connected domain.",
  },
  wordpress: {
    name: "WordPress",
    steps: [
      "Install a header-and-footer code plugin, such as WPCode.",
      "Open its Header & Footer settings and paste the snippet into the Footer box.",
      "Save. The buttons appear on every page.",
    ],
  },
  shopify: {
    name: "Shopify",
    steps: [
      "Go to Online Store → Themes, open the menu on your live theme and choose Edit code.",
      "Open theme.liquid and paste the snippet just before the closing </body> tag.",
      "Save.",
    ],
  },
  webflow: {
    name: "Webflow",
    steps: [
      "Open Site settings → Custom code.",
      "Paste the snippet into Footer code and save.",
      "Publish the site — custom code only goes live on publish.",
    ],
  },
  godaddy: {
    name: "GoDaddy Website Builder",
    steps: [
      "Edit your website and add a section of type HTML (sometimes called Custom code).",
      "Paste the snippet into it and publish.",
    ],
    note: "GoDaddy can run custom code inside its section rather than over the page. If the buttons only show inside that section, tell us and we will help.",
  },
  custom: {
    name: "Your own site",
    steps: [
      "Paste the snippet just before the closing </body> tag, on every page — usually once, in the shared footer template.",
      "Deploy or publish as you normally would.",
    ],
  },
};

export interface InstallCheck {
  platform: Platform | null;
  installed: boolean;
  reason?: string;
}

/** Fetch the venue's site and look for its own widget key. Never throws. */
export async function checkInstall(rawUrl: string, key: string): Promise<InstallCheck> {
  let url: URL;
  try {
    url = await assertPublicUrl(rawUrl);
  } catch (err) {
    return { platform: null, installed: false, reason: err instanceof Error ? err.message : "That address cannot be checked." };
  }
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "BellineInstallCheck/1.0 (+https://belline.ai)", Accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { platform: null, installed: false, reason: `Your site returned ${res.status}.` };
    const html = (await res.text()).slice(0, 600_000);
    return installedIn(html, key);
  } catch {
    return { platform: null, installed: false, reason: "Could not reach your site." };
  }
}

/** Pure half of the check, for the tests. */
export function installedIn(html: string, key: string): InstallCheck {
  const installed = html.includes(`data-belline="${key}"`) || html.includes(`data-belline='${key}'`);
  return {
    platform: detectPlatform(html),
    installed,
    reason: installed ? undefined : "The snippet is not on that page yet. Builders can take a minute to publish — try again shortly.",
  };
}
