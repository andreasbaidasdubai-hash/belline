import type { Vertical } from "../types";
import type { Extracted } from "../prospect";

/**
 * What the reader may call a service, checked in code.
 *
 * A property developer's website is a list of projects: "Burj Khalifa
 * Residences", "Dubai Hills Estate", "Emaar Beachfront", a sales centre in each
 * district. The reader turned every one of them into a bookable service, and
 * the review screen offered to take bookings for a tower. The model is told
 * what a service is (prospect.ts), but an instruction is a request, not a
 * guarantee, so this filter holds whatever the model sends back.
 *
 * It is deliberately narrow for the trades where the old reading was right. A
 * salon's "Gel manicure" and a clinic's "Check-up" match none of the words
 * below, the project and listing words apply only to the trades that list
 * things, and a restaurant's menu sections are never judged by name at all —
 * "Seafood tower" is a platter. What is dropped is always reported on the
 * review screen, so an owner whose real service was caught can add it back.
 */

/**
 * The trades whose websites list things rather than things to book: projects,
 * listings, practice areas, courses, stock. The listing words and the listing
 * price below apply only to them.
 */
export const LISTING_TRADES = new Set(["property", "professional", "education", "retail"]);

/**
 * Of those, the ones where an entry with neither a price nor a length is not
 * taken as a service at all: a property listing never has a length, and what a
 * shop's website names with no price is a product range. A law firm's practice
 * areas and a school's courses often have neither and are still real, so the
 * other two are not held to it.
 */
const STRICT_TRADES = new Set(["property", "retail"]);

/**
 * A place rather than a service, at any business but a restaurant. Only words
 * no salon, clinic, garage or tutor sells by: "Dubai Mall branch" is a place a
 * salon has, never something it books.
 */
const PLACE_WORDS =
  /\b(residences?|towers?|branch(es)?|sales\s+cent(re|er)s?|communit(y|ies)|mall|beachfront|off[-\s]?plan|phase\s*\d+)\b/i;

/**
 * A project or a listing, only where the trade sells, lets or develops things.
 * Kept away from the other trades on purpose: "Renovation projects" is a
 * builder's service, "Villa deep clean" a cleaner's, "Estate planning" a
 * lawyer's — so "estate" is only a listing when planning does not follow.
 */
const LISTING_WORDS =
  /\b(developments?|projects?|estates?(?!\s+planning)|master[-\s]?plan(ned)?|villas?|apartments?|townhouses?|penthouses?|plots?|showrooms?|for\s+(sale|rent|lease))\b|\b\d+\s*-?\s*(bed(room)?s?|br)\b/i;

/** Headings a model may report an item was listed under that are never services. */
const PLACE_SECTIONS =
  /\b(projects?|developments?|communit(y|ies)|branch(es)?|locations?|our\s+stores|stores|showrooms?|portfolio|listings?|properties|brands?|off[-\s]?plan|destinations?|campus(es)?)\b/i;

/** Above this, a "price" is a property or a car, not something booked. */
const LISTING_PRICE = 100_000;

export type Candidate = Extracted["services"][number] & { section?: string };

export interface Dropped {
  name: string;
  why: "project" | "listing" | "section" | "staff" | "unpriced";
}

export function filterServices(
  services: Candidate[],
  context: { trade?: string; vertical?: Vertical; staff?: string[] },
): { kept: Extracted["services"]; dropped: Dropped[] } {
  const listing = LISTING_TRADES.has(context.trade ?? "");
  const strict = STRICT_TRADES.has(context.trade ?? "");
  // A menu is judged only by the heading it sat under: dish names are too
  // varied for a word list to be fair to them.
  const byName = context.vertical !== "restaurant";
  const staff = new Set((context.staff ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean));

  const kept: Extracted["services"] = [];
  const dropped: Dropped[] = [];
  for (const s of services ?? []) {
    const name = String(s?.name ?? "").trim();
    if (!name) continue;
    const price = Number(s.price) || 0;
    const minutes = Number(s.durationMin) || 0;
    const why: Dropped["why"] | null =
      s.section && PLACE_SECTIONS.test(s.section)
        ? "section"
        : staff.has(name.toLowerCase())
          ? "staff"
          : byName && PLACE_WORDS.test(name)
            ? "project"
            : listing && (LISTING_WORDS.test(name) || price >= LISTING_PRICE)
              ? "listing"
              : strict && !price && !minutes
                ? "unpriced"
                : null;
    if (why) dropped.push({ name, why });
    // Only the three fields a service has; the heading was for this filter.
    else kept.push({ name, durationMin: minutes, price });
  }
  return { kept, dropped };
}

/**
 * The sentence the review screen shows under "What you offer" when anything
 * was left out: which items, and that they can be added back. Never silent —
 * an owner who wonders where their list went has the answer beside the list.
 */
export function droppedNote(dropped: Dropped[]): string {
  if (!dropped.length) return "";
  const names = dropped.slice(0, 6).map((d) => d.name);
  const more = dropped.length > names.length ? ` and ${dropped.length - names.length} more` : "";
  const what = dropped.length === 1 ? "1 item" : `${dropped.length} items`;
  return (
    `Left out ${what} that look like projects, branches, listings or people rather than something a customer books: ` +
    `${names.join(", ")}${more}. Add any that really are services.`
  );
}
