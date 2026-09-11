/**
 * The lead-source seam.
 *
 * Requirement §1: "Do not tightly couple the application to one data provider.
 * Create a provider interface so that sources can be swapped later." Every
 * connector — Google Places, a CSV, Apollo, a local directory, a website
 * crawl — implements this and nothing downstream knows which one ran.
 *
 * The shape is an async iterable rather than a promise of an array because
 * discovery is paginated and metered: a run that finds 400 clinics should be
 * able to stop at 50 without paying for pages 3–20, and the caller decides
 * when to stop.
 */

export interface DiscoveryQuery {
  countryCode: string;
  /** Cities/emirates/cantons to search. One search per region per term. */
  regions: string[];
  verticalSlug: string;
  /** What to actually type into the source, e.g. "dental clinic". */
  searchTerms: string[];
  /** Stop after this many results across all pages. */
  limit: number;
  languageCode?: string;
}

/**
 * A company as a source describes it, before normalisation or dedup.
 *
 * Every field is optional except the name, because sources disagree wildly
 * about what they know — and a connector that invents a value to fill a gap
 * is worse than one that leaves it null. `null` here means "this source did
 * not say", which is different from false or zero, and the scoring model
 * treats it differently.
 */
export interface RawCompany {
  name: string;
  legalName?: string | null;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  countryCode?: string | null;
  verticalSlug?: string | null;
  subVertical?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  openingHours?: unknown;
  bookingUrl?: string | null;
  /** The source's own stable id — `place_id` for Google. Exact, free dedup. */
  externalId?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** Where a human can go to see this record. */
  sourceUrl?: string | null;
  /** `closed` marks permanently-closed businesses, which score to zero. */
  status?: "active" | "closed";
}

export interface LeadSourceProvider {
  readonly slug: string;
  /** Planning figure used for budget headroom before a run. */
  readonly costPerResultUsd: number;
  /** False when the provider's key is missing. Never throws. */
  available(): boolean;
  /** Why it is unavailable, for the dashboard. */
  unavailableReason(): string | null;
  search(query: DiscoveryQuery): AsyncIterable<RawCompany>;
}

/** Thrown for a provider failure the queue should retry. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
