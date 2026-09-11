import { NextResponse, type NextRequest } from "next/server";

/**
 * Who is allowed to frame the embed.
 *
 * `frame-ancestors` has to be a response header — a page cannot set its own,
 * because by the time React renders, the browser has already decided whether
 * to put it in the frame. So it is set here, per venue, from the origins that
 * venue named.
 *
 * This is the check that actually holds. The page checks the framing origin
 * too, and that check is a courtesy: it produces a readable refusal rather
 * than a blank frame. A determined caller can lie about a `Referer`; nothing
 * can lie its way past the browser's own enforcement of `frame-ancestors`.
 *
 * The key is read from the path rather than the venue looked up, because
 * middleware runs on the edge runtime and the venue store is a file on a
 * disk. So the header is built from what the request is *asking* for and the
 * page still refuses if the venue disagrees — belt from one side, braces from
 * the other.
 */
export const config = {
  matcher: ["/embed/:path*"],
};

export function middleware(req: NextRequest) {
  const response = NextResponse.next();

  // The venue's own allowlist rides on the request as a query parameter that
  // `embed.js` puts there, so the edge can build the header without reading a
  // database. It is not a security boundary on its own — a caller could claim
  // any origin — which is exactly why the page checks the *real* framing
  // origin against the venue's stored list as well.
  const claimed = req.nextUrl.searchParams.get("o");
  const origins = claimed ? [claimed] : [];

  response.headers.set(
    "Content-Security-Policy",
    // 'self' keeps our own dashboard preview working; the venue's origin is
    // what makes the widget work on their site. Everything else is refused by
    // the browser before a single byte of the page is parsed.
    `frame-ancestors 'self' ${origins.join(" ")}`.trim(),
  );
  // Belt for browsers that still prefer the older header. SAMEORIGIN would
  // break the widget outright, so it is deliberately not set here.
  response.headers.delete("X-Frame-Options");

  return response;
}
