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
