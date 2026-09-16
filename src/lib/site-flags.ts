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

/** The page's hand-written flag copy as the flags in `env` say it. */
export function applySiteFlags(file: string, html: string, env: Env = process.env): string {
  let out = html;
  for (const [name, swaps] of Object.entries(SITE_FLAG_COPY) as [FlagName, SiteSwap[]][]) {
    const on = publicFlag(name, env);
    for (const swap of swaps) {
      if (swap.file !== file) continue;
      out = on ? out.split(swap.off).join(swap.on) : out.split(swap.on).join(swap.off);
    }
  }
  return out;
}

/** Swaps whose `off` sentence is not in its page exactly once, as "file: sentence". Empty when all are found. */
export function strandedSiteCopy(read: (file: string) => string): string[] {
  const out: string[] = [];
  for (const swaps of Object.values(SITE_FLAG_COPY)) {
    for (const swap of swaps ?? []) {
      if (read(swap.file).split(swap.off).length !== 2) out.push(`${swap.file}: ${swap.off}`);
    }
  }
  return out;
}
