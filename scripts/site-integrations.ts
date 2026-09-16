/**
 * The integrations strip on the landing page, generated from the flags.
 *
 * Six systems an operator already books with. None of them is connected when
 * this was written: Google Calendar and Outlook are being built, and Fresha,
 * SevenRooms, OpenTable and Treatwell issue credentials only under a partner
 * agreement Belline does not have. So the strip never says "works with" or
 * "integrates with", and every name carries its state as words, not colour.
 *
 * The state comes from `src/lib/flags.ts` at build time and nowhere else:
 * `booking.google` on turns Google Calendar's tag to "Available", and the same
 * for `booking.outlook` and each `booking.partner.<id>`. Nobody edits the tag
 * by hand, so the site cannot say "Available" a day before the product does,
 * or keep saying "Coming soon" a day after.
 *
 * Each name sits under that company's app icon, at the founder's decision on
 * 2026-09-16 (the trademark question was raised and accepted). The icons are
 * self-hosted copies in public/img/logos, never hotlinked, and the name is
 * always there in text as well: the icon is decoration (alt=""), the words are
 * what a screen reader and check-webchat read.
 *
 * public/landing.html carries the block as every flag-off build renders it,
 * which is also what the app serves from that template; check-webchat pins
 * the two together. `npm run site` re-renders it from the build's own env.
 */

import type { FlagName } from "../src/lib/flags";
import { publicFlag } from "../src/lib/site-flags";

type Env = Record<string, string | undefined>;

export type IntegrationState = "available" | "soon" | "roadmap";

export interface Integration {
  name: string;
  /** Its app icon, a file in public/img/logos. */
  logo: string;
  /** The flag that says it works on this deployment. */
  flag: FlagName;
  /** What the tag says while the flag is off. */
  pending: Exclude<IntegrationState, "available">;
}

/** In the order a visitor reads them: the two being built, then the partners. */
export const INTEGRATIONS: readonly Integration[] = [
  { name: "Google Calendar", logo: "google-calendar.png", flag: "booking.google", pending: "soon" },
  { name: "Outlook", logo: "outlook.png", flag: "booking.outlook", pending: "soon" },
  { name: "Fresha", logo: "fresha.png", flag: "booking.partner.fresha", pending: "roadmap" },
  { name: "SevenRooms", logo: "sevenrooms.png", flag: "booking.partner.sevenrooms", pending: "roadmap" },
  { name: "OpenTable", logo: "opentable.png", flag: "booking.partner.opentable", pending: "roadmap" },
  { name: "Treatwell", logo: "treatwell.png", flag: "booking.partner.treatwell", pending: "roadmap" },
];

export const INTEGRATIONS_HEADING = "Connecting to the tools you already use";

export const STATE_LABEL: Record<IntegrationState, string> = {
  available: "Available",
  soon: "Coming soon",
  roadmap: "On our roadmap",
};

const STATE_CLASS: Record<IntegrationState, string> = {
  available: "state state-available",
  soon: "state state-soon",
  roadmap: "state state-roadmap",
};

/**
 * The flags as a public page may read them: without `FLAG_STUBS`, which is a
 * test harness and never a reason to tell the public a connection is
 * available. One definition, shared with the page copy in src/lib/site-flags.ts.
 */
export function integrationState(item: Integration, env: Env): IntegrationState {
  return publicFlag(item.flag, env) ? "available" : item.pending;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The list itself: six names under their icons, each with its state in words. */
export function renderIntegrations(env: Env): string {
  const items = INTEGRATIONS.map((item) => {
    const state = integrationState(item, env);
    return `        <li class="connect" data-integration="${esc(item.flag)}" data-state="${state}">
          <img class="connect-logo" src="/img/logos/${esc(item.logo)}" width="40" height="40" alt="" loading="lazy">
          <span class="connect-name">${esc(item.name)}</span>
          <span class="${STATE_CLASS[state]}">${STATE_LABEL[state]}</span>
        </li>`;
  }).join("\n");
  return `      <ul class="connects-list" aria-label="Booking systems and calendars, and where each connection stands">
${items}
      </ul>`;
}

const START = "<!-- integrations:start";
const END = "<!-- integrations:end -->";
const MARKER_NOTE =
  "<!-- integrations:start — generated from src/lib/flags.ts by scripts/site-integrations.ts. Tags follow the flags at build time; do not edit by hand. Each name under its self-hosted app icon (public/img/logos). -->";

/**
 * Replace the block between the markers. Throws when they are gone, rather
 * than build a page whose strip has silently stopped following the flags.
 */
export function applyIntegrations(html: string, env: Env): string {
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from < 0 || to < 0 || to < from) {
    throw new Error("public/landing.html has lost its integrations:start / integrations:end markers.");
  }
  return `${html.slice(0, from)}${MARKER_NOTE}\n${renderIntegrations(env)}\n${html.slice(to)}`;
}
