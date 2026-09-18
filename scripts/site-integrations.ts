/**
 * The integrations strip on the landing page, generated from the flags.
 *
 * Nine systems an operator already books with. None of them is connected when
 * this was written: Google Calendar, Outlook and Calendly are being built, and
 * Fresha, SevenRooms, OpenTable, Treatwell, Zenoti and Mindbody issue
 * credentials only under a partner agreement Belline does not have. So the strip never says "works with" or
 * "integrates with", and every name carries its state as words, not colour.
 *
 * Calendly moved out of the partner group on 2026-09-18: unlike the other six
 * its API is self-serve, so the adapter could be built without an agreement
 * (src/lib/integrations/calendly.ts). It is "Coming soon" beside the other two
 * until `booking.calendly` is switched on, which is the same promise the
 * product makes and no more.
 *
 * The state comes from `src/lib/flags.ts` at build time and nowhere else:
 * `booking.google` on turns Google Calendar's tag to "Available", and the same
 * for `booking.outlook`, `booking.calendly` and each `booking.partner.<id>`.
 * Nobody edits the tag by hand, so the site cannot say "Available" a day before
 * the product does, or keep saying "Coming soon" a day after.
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

/** In the order a visitor reads them: the three being built, then the partners. */
export const INTEGRATIONS: readonly Integration[] = [
  { name: "Google Calendar", logo: "google-calendar.png", flag: "booking.google", pending: "soon" },
  { name: "Outlook", logo: "outlook.png", flag: "booking.outlook", pending: "soon" },
  { name: "Calendly", logo: "calendly.png", flag: "booking.calendly", pending: "soon" },
  { name: "Fresha", logo: "fresha.png", flag: "booking.partner.fresha", pending: "roadmap" },
  { name: "SevenRooms", logo: "sevenrooms.png", flag: "booking.partner.sevenrooms", pending: "roadmap" },
  { name: "OpenTable", logo: "opentable.png", flag: "booking.partner.opentable", pending: "roadmap" },
  { name: "Treatwell", logo: "treatwell.png", flag: "booking.partner.treatwell", pending: "roadmap" },
  // Added 2026-09-16 at the founder's request; which partners to approach is still to be decided.
  { name: "Zenoti", logo: "zenoti.png", flag: "booking.partner.zenoti", pending: "roadmap" },
  { name: "Mindbody", logo: "mindbody.png", flag: "booking.partner.mindbody", pending: "roadmap" },
];

export const INTEGRATIONS_HEADING = "Connecting to the tools you already use";

export const STATE_LABEL: Record<IntegrationState, string> = {
  available: "Available",
  soon: "Coming soon",
  roadmap: "On our roadmap",
};

/** The page language the strip is written in. */
export type StripLang = "en" | "de";

/**
 * The German pages' strip: the same states from the same flags, in German.
 * "Demnächst" and "Geplant", never "funktioniert mit" or "integriert mit".
 */
export const INTEGRATIONS_HEADING_DE = "Verbindungen zu den Tools, die Sie schon nutzen";

export const STATE_LABEL_DE: Record<IntegrationState, string> = {
  available: "Verfügbar",
  soon: "Demnächst",
  roadmap: "Geplant",
};

const LIST_LABEL: Record<StripLang, string> = {
  en: "Booking systems and calendars, and where each connection stands",
  de: "Buchungssysteme und Kalender, und wo jede Verbindung steht",
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

/** The group headings, by state: what connects today first, the roadmap last and quietest. */
export const GROUP_HEADING: Record<StripLang, Record<IntegrationState, string>> = {
  en: { available: "Connects today", soon: "Coming soon", roadmap: "On our roadmap" },
  de: { available: "Heute verbunden", soon: "Demnächst", roadmap: "Geplant" },
};

/**
 * The strip: one group per state that has a name in it, in the order
 * available, coming soon, roadmap. "Connects today" only exists while a flag
 * is on, so it can never head a list of things that do not connect. Every
 * name keeps its tag in words under its icon, and the roadmap row is set
 * smaller and lighter (site.css), because it is not something to buy on.
 * Nothing moves.
 */
export function renderIntegrations(env: Env, lang: StripLang = "en"): string {
  const labels = lang === "de" ? STATE_LABEL_DE : STATE_LABEL;
  const order: IntegrationState[] = ["available", "soon", "roadmap"];
  const groups = order
    .map((state) => ({ state, items: INTEGRATIONS.filter((item) => integrationState(item, env) === state) }))
    .filter((g) => g.items.length > 0)
    .map(({ state, items }) => {
      const lis = items
        .map(
          (item) => `          <li class="connect" data-integration="${esc(item.flag)}" data-state="${state}">
            <img class="connect-logo" src="/img/logos/${esc(item.logo)}" width="40" height="40" alt="" loading="lazy">
            <span class="connect-name">${esc(item.name)}</span>
            <span class="${STATE_CLASS[state]}">${labels[state]}</span>
          </li>`,
        )
        .join("\n");
      return `        <div class="connects-group connects-${state}">
          <h3 class="connects-group-h">${GROUP_HEADING[lang][state]}</h3>
          <ul class="connects-list">
${lis}
          </ul>
        </div>`;
    })
    .join("\n");
  return `      <div class="connects-groups" role="group" aria-label="${LIST_LABEL[lang]}">
${groups}
      </div>`;
}

const START = "<!-- integrations:start";
const END = "<!-- integrations:end -->";
const MARKER_NOTE =
  "<!-- integrations:start — generated from src/lib/flags.ts by scripts/site-integrations.ts. Tags follow the flags at build time; do not edit by hand. Each name under its self-hosted app icon (public/img/logos). -->";

/**
 * Replace the block between the markers. Throws when they are gone, rather
 * than build a page whose strip has silently stopped following the flags.
 */
export function applyIntegrations(html: string, env: Env, lang: StripLang = "en"): string {
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from < 0 || to < 0 || to < from) {
    throw new Error(`public/${lang === "de" ? "landing.de.html" : "landing.html"} has lost its integrations:start / integrations:end markers.`);
  }
  return `${html.slice(0, from)}${MARKER_NOTE}\n${renderIntegrations(env, lang)}\n${html.slice(to)}`;
}
