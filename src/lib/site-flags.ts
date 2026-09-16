import { flag, type FlagName } from "./flags";

type Env = Record<string, string | undefined>;

/**
 * The public website's copy for capabilities behind a flag.
 *
 * The pages in `public/` are written as every flag-off build renders them:
 * that is what the checks read and the honest default. Each hand-written
 * sentence that has to change when a capability is switched on is listed here
 * with its replacement, and nobody edits it in step with an environment
 * variable. Two places apply it, from the same `flag()` the product reads:
 *
 * - `scripts/build-site.ts`, at build time, like the integrations strip
 *   (scripts/site-integrations.ts), so a static build is right for its env;
 * - `marketing.ts`, as the app's own server serves the built site, because the
 *   Docker build on Railway runs without the service's variables (there is no
 *   ARG for them, and the flag also needs the Google secrets, which do not
 *   belong in an image). A build-time switch alone would say "Coming soon" in
 *   production whatever the flag says.
 *
 * Both directions: applying "off" to a page built with the flag on puts the
 * flag-off sentences back, so the page served always matches the flag the
 * server has now.
 *
 * A sentence that no longer appears in its page is an error (`check:google`),
 * so rewording a page cannot silently strand its flag-on copy.
 *
 * Flags compose in the order they are listed. Outlook's swaps are written
 * against the page as Google's flag has already left it: its `off` is either
 * Google's flag-off sentence (Outlook alone) or Google's flag-on sentence
 * (both), and its `on` names what is then true. To apply, every swap is first
 * reverted, last flag first, and then the flags that are on are applied, first
 * flag first, so any mix of flags and any page already built with others comes
 * out the same.
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
  "booking.outlook": [
    // The hero's lead: Outlook alone, then Google and Outlook.
    {
      file: "landing.html",
      off: "Soon, it will also book straight into the calendar you already use.",
      on: "It can also book straight into your Outlook calendar, after checking it for times already taken.",
    },
    {
      file: "landing.html",
      off: "It can also book straight into your Google Calendar, after checking it for times already taken.",
      on: "It can also book straight into your Google Calendar or Outlook, after checking it for times already taken.",
    },
    // The example calendar's badge.
    {
      file: "landing.html",
      off: '<span class="state state-soon cal-soon">Coming soon: books into your calendar</span>',
      on: '<span class="state state-available cal-soon">Books into Outlook</span>',
    },
    {
      file: "landing.html",
      off: '<span class="state state-available cal-soon">Books into Google Calendar</span>',
      on: '<span class="state state-available cal-soon">Books into Google Calendar or Outlook</span>',
    },
    // "Whatever you book with".
    {
      file: "landing.html",
      off: "<dd>Belline takes booking requests today. Booking straight into Google Calendar is coming soon.</dd>",
      on: "<dd>Connect Outlook and Belline checks it for times already taken, then books straight into it. Booking straight into Google Calendar is coming soon.</dd>",
    },
    {
      file: "landing.html",
      off: "<dd>Connect Google Calendar and Belline checks it for times already taken, then books straight into it. Outlook isn’t connected yet, so for Outlook Belline takes booking requests.</dd>",
      on: "<dd>Connect Google Calendar or Outlook and Belline checks it for times already taken, then books straight into it.</dd>",
    },
  ],
};

/**
 * The flags as a public page may read them.
 *
 * `FLAG_STUBS=on` stands fake providers in for missing credentials so a local
 * end-to-end run can exercise a capability. That is a test harness, not a
 * product: a site built or served with stubs on must not tell the public a
 * connection is available.
 */
export function publicEnv(env: Env): Env {
  const rest = { ...env };
  delete rest.FLAG_STUBS;
  return rest;
}

/** Is this flag on, as the public website may say so? */
export function publicFlag(name: FlagName, env: Env = process.env): boolean {
  return flag(name, publicEnv(env));
}

const swap = (html: string, from: string, to: string) => html.split(from).join(to);

/** The page's hand-written flag copy as the flags in `env` say it. */
export function applySiteFlags(file: string, html: string, env: Env = process.env): string {
  const flags = Object.entries(SITE_FLAG_COPY) as [FlagName, SiteSwap[]][];
  let out = html;
  // Back to the page as written: last flag first, each swap in reverse.
  for (const [, swaps] of [...flags].reverse()) {
    for (const s of [...swaps].reverse()) if (s.file === file) out = swap(out, s.on, s.off);
  }
  // Then forward, for the flags that are on.
  for (const [name, swaps] of flags) {
    if (!publicFlag(name, env)) continue;
    for (const s of swaps) if (s.file === file) out = swap(out, s.off, s.on);
  }
  return out;
}

/**
 * Swaps whose `off` sentence is not in its page exactly once, as "file:
 * sentence". A later flag's swap may be written against the page with the
 * earlier flags on, so it is also looked for there. Empty when all are found.
 */
export function strandedSiteCopy(read: (file: string) => string): string[] {
  const out: string[] = [];
  const flags = Object.entries(SITE_FLAG_COPY) as [FlagName, SiteSwap[]][];
  flags.forEach(([, swaps], i) => {
    for (const s of swaps) {
      const page = read(s.file);
      let earlierOn = page;
      for (const [, before] of flags.slice(0, i)) for (const b of before) if (b.file === s.file) earlierOn = swap(earlierOn, b.off, b.on);
      if (page.split(s.off).length !== 2 && earlierOn.split(s.off).length !== 2) out.push(`${s.file}: ${s.off}`);
    }
  });
  return out;
}
