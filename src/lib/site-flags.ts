import { flag, type FlagName } from "./flags";

/**
 * The public website's copy for capabilities behind a flag.
 *
 * The pages in `public/` say what is true with every flag off: that is what
 * the checks read, what a static host serves, and the honest default. Each
 * sentence that has to change when a capability is switched on is listed here
 * with its replacement, and the app's own server swaps them as it serves the
 * page (marketing.ts), from the same `flag()` the product reads. So turning
 * `FLAG_BOOKING_GOOGLE` on changes the website with it, and turning it off
 * again changes it back, with nobody editing copy by hand.
 *
 * At serve time rather than build time on purpose: the Docker build runs
 * without the service's variables, so a build-time switch would bake in "off"
 * whatever production says.
 *
 * A sentence that no longer appears in its page is an error (see
 * `check:google`), so rewording the page cannot silently strand the "on" copy.
 */

export interface SiteSwap {
  /** The page in `public/`, by its source name. */
  file: string;
  /** Exactly as it appears in the page. */
  off: string;
  on: string;
}

export const SITE_FLAG_COPY: Partial<Record<FlagName, SiteSwap[]>> = {
  "booking.google": [
    {
      file: "landing.html",
      off: "Soon, it will also book straight into the calendar you already use.",
      on: "It can also book straight into your Google Calendar, after checking it for times already taken.",
    },
    {
      file: "landing.html",
      off: '<span class="state state-soon cal-soon">Coming soon: books into your calendar</span>',
      on: '<span class="state state-available cal-soon">Books into Google Calendar</span>',
    },
    {
      file: "landing.html",
      off: "<dd>Belline takes booking requests today. Booking straight into Google Calendar is coming soon.</dd>",
      on: "<dd>Connect Google Calendar and Belline checks it for times already taken, then books straight into it. Outlook isn’t connected yet, so for Outlook Belline takes booking requests.</dd>",
    },
    {
      file: "privacy.html",
      off: "<li><strong>Google</strong> — only if a business connects a Google Calendar, once that connection is available. No calendar can be connected yet.</li>",
      on: "<li><strong>Google</strong> — only if a business connects a Google Calendar.</li>",
    },
    {
      file: "privacy.html",
      off: "<p>Connecting a Google Calendar is not available yet. When it is, and only if a business chooses to connect one, this is how Belline treats the information it receives from Google:</p>",
      on: "<p>Connecting a Google Calendar is optional. Only if a business chooses to connect one, this is how Belline treats the information it receives from Google:</p>",
    },
  ],
};

/** The page's copy with every flag as it is in `env`. Unchanged with them all off. */
export function applySiteFlags(file: string, html: string, env: Record<string, string | undefined> = process.env): string {
  let out = html;
  for (const [name, swaps] of Object.entries(SITE_FLAG_COPY) as [FlagName, SiteSwap[]][]) {
    if (!flag(name, env)) continue;
    for (const swap of swaps) {
      if (swap.file === file) out = out.split(swap.off).join(swap.on);
    }
  }
  return out;
}

/** Swaps whose `off` sentence is no longer in its page, as "file: sentence". Empty when all are found. */
export function strandedSiteCopy(read: (file: string) => string): string[] {
  const out: string[] = [];
  for (const swaps of Object.values(SITE_FLAG_COPY)) {
    for (const swap of swaps ?? []) {
      if (read(swap.file).split(swap.off).length !== 2) out.push(`${swap.file}: ${swap.off}`);
    }
  }
  return out;
}
