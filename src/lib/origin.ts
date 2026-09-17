/**
 * Where the app is served, as the rest of the internet addresses it.
 *
 * Never the request's own origin. Behind Railway's proxy a route handler sees
 * the container's address, so a redirect built from `req.url` sends a person to
 * `localhost:3000` — which is where every sign-in link went until this existed.
 *
 * `PUBLIC_APP_URL` first, for the one caller that named it that; `PUBLIC_ORIGIN`
 * is what Railway sets.
 */
export function appOrigin(): string {
  return (process.env.PUBLIC_APP_URL || process.env.PUBLIC_ORIGIN || "https://app.belline.ai").replace(
    /\/+$/,
    "",
  );
}

/**
 * Where the marketing website is, for the app's links to the terms, the privacy
 * policy, the logo and "chat with Belle".
 *
 * On production the app is `app.belline.ai` and the site is `belline.ai`. Every
 * other environment — staging, a preview, a local server — has no second
 * host: the same process serves the website by hostname (marketing.ts), so
 * the site is the app's own origin. A hard-coded `https://belline.ai` there
 * sent a staging tester to production halfway through a staging signup.
 */
export function siteOrigin(): string {
  const app = appOrigin();
  try {
    const host = new URL(app).hostname.toLowerCase();
    if (host === "belline.ai" || host.endsWith(".belline.ai")) return "https://belline.ai";
  } catch {
    return "https://belline.ai";
  }
  return app;
}
