import {
  ProviderError,
  type DiscoveryQuery,
  type LeadSourceProvider,
  type RawCompany,
} from "./provider";

/**
 * Google Places API (New) — Text Search.
 *
 * The only lawful way to get Maps business data at volume. Scraping Maps
 * violates Google's terms and is not an option this design considers, which is
 * why this connector exists rather than a headless browser.
 *
 * Two things dominate the economics and both are handled here:
 *
 *   **Field masks are the bill.** Places bills by SKU tier, and the tier is
 *   decided by the most expensive field you ask for. Requesting review *text*
 *   moves every request to the top tier for data we do not use — so the mask
 *   below is explicit, minimal, and commented with why each field earns its
 *   place. Never replace it with `*`.
 *
 *   **`place_id` is free, exact dedup.** It is stable across runs, so a second
 *   pass over the same city costs the API call but writes nothing new.
 */

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

/**
 * Exactly what the ICP and the scoring model consume, and nothing else.
 *
 * Tiers, at time of writing: `id`/`name` are Essentials; `displayName`,
 * `formattedAddress`, `location`, `types`, `businessStatus`, `googleMapsUri`
 * are Pro; `rating`, `userRatingCount`, `internationalPhoneNumber`,
 * `websiteUri`, `regularOpeningHours` are Enterprise. We sit in Enterprise
 * because phone and website are the difference between a lead and a row.
 *
 * Deliberately absent: `places.reviews`. Review text would tell us whether
 * callers complain about unanswered phones — a real scoring signal — but it
 * moves every request to Enterprise+Atmosphere. The research agent reads the
 * website for that signal instead, at a fraction of the cost.
 */
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.shortFormattedAddress",
  "places.location",
  "places.types",
  "places.primaryType",
  "places.businessStatus",
  "places.googleMapsUri",
  "places.rating",
  "places.userRatingCount",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.regularOpeningHours",
  "nextPageToken",
].join(",");

/** Places caps a page at 20 and allows two further pages. */
const PAGE_SIZE = 20;
const MAX_PAGES = 3;

interface PlacesResponse {
  places?: GooglePlace[];
  nextPageToken?: string;
}

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  shortFormattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  types?: string[];
  primaryType?: string;
  businessStatus?: string;
  googleMapsUri?: string;
  rating?: number;
  userRatingCount?: number;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[]; openNow?: boolean };
}

// ---------------------------------------------------------------------------
// Mapping — pure, and therefore the part that is actually tested
// ---------------------------------------------------------------------------

/**
 * A Places result as a company.
 *
 * Returns null for anything not worth a row: a result with no name, or one
 * Google says is permanently closed. Filtering here rather than at scoring
 * time means we never pay research tokens on a business that shut last year.
 */
export function toRawCompany(
  place: GooglePlace,
  context: { countryCode: string; verticalSlug: string; city?: string },
): RawCompany | null {
  const name = place.displayName?.text?.trim();
  if (!name) return null;

  if (place.businessStatus === "CLOSED_PERMANENTLY") return null;

  return {
    name,
    website: place.websiteUri ?? null,
    // Places returns E.164-ish with spaces ("+971 4 123 4567"); our own
    // normaliser handles the rest and owns the dedup key.
    phone: place.internationalPhoneNumber ?? null,
    address: place.formattedAddress ?? place.shortFormattedAddress ?? null,
    city: context.city ?? null,
    countryCode: context.countryCode,
    verticalSlug: context.verticalSlug,
    // Google's own category is a better sub-vertical than anything we'd infer.
    subVertical: place.primaryType ?? place.types?.[0] ?? null,
    rating: typeof place.rating === "number" ? place.rating : null,
    reviewCount: typeof place.userRatingCount === "number" ? place.userRatingCount : null,
    openingHours: place.regularOpeningHours?.weekdayDescriptions ?? null,
    externalId: place.id ?? null,
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    sourceUrl: place.googleMapsUri ?? null,
    status: place.businessStatus === "CLOSED_TEMPORARILY" ? "closed" : "active",
  };
}

/**
 * One text query per region per term.
 *
 * "dental clinic in Dubai" rather than a location bias, because Text Search
 * reads the place name in the query and a bare bias returns the same twenty
 * results for every term. Region and term both come from configuration — no
 * vertical is named in this file.
 */
export function buildQueries(query: DiscoveryQuery): { text: string; city: string }[] {
  const regions = query.regions.length > 0 ? query.regions : [""];
  const out: { text: string; city: string }[] = [];
  for (const region of regions) {
    for (const term of query.searchTerms) {
      out.push({ text: region ? `${term} in ${region}` : term, city: region });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export class GooglePlacesProvider implements LeadSourceProvider {
  readonly slug = "google_places";

  /**
   * Planning figure only — the real charge comes from Google. Configurable
   * because the SKU price changes and a stale constant silently misreports
   * cost-per-lead, which is the number the whole model is tuned on.
   */
  readonly costPerResultUsd = Number(process.env.GOOGLE_PLACES_COST_PER_RESULT ?? 0.0035);

  private readonly apiKey = process.env.GOOGLE_PLACES_API_KEY ?? "";

  available(): boolean {
    return this.apiKey.length > 0;
  }

  unavailableReason(): string | null {
    return this.available()
      ? null
      : "GOOGLE_PLACES_API_KEY is not set. Create a key in Google Cloud with the Places API (New) enabled and billing on, then restrict it by API and IP.";
  }

  async *search(query: DiscoveryQuery): AsyncIterable<RawCompany> {
    if (!this.available()) {
      throw new ProviderError(this.unavailableReason()!, this.slug, false);
    }

    let yielded = 0;
    const seen = new Set<string>();

    for (const { text, city } of buildQueries(query)) {
      let pageToken: string | undefined;

      for (let page = 0; page < MAX_PAGES; page++) {
        if (yielded >= query.limit) return;

        const body: Record<string, unknown> = {
          textQuery: text,
          pageSize: Math.min(PAGE_SIZE, query.limit - yielded),
          // Biases results to the country and, more importantly, keeps a
          // "dental clinic in Dubai" query from returning Dubai, Ohio.
          regionCode: query.countryCode,
          languageCode: query.languageCode ?? "en",
        };
        if (pageToken) body.pageToken = pageToken;

        const response = await this.post(body);

        for (const place of response.places ?? []) {
          if (yielded >= query.limit) return;
          // Google returns the same clinic for "dental clinic in Dubai" and
          // "dentist in Dubai". Deduping on place_id here saves the database
          // a write and us a round trip; the real dedup still runs downstream.
          if (place.id && seen.has(place.id)) continue;
          if (place.id) seen.add(place.id);

          const company = toRawCompany(place, {
            countryCode: query.countryCode,
            verticalSlug: query.verticalSlug,
            city: city || undefined,
          });
          if (!company) continue;

          yielded++;
          yield company;
        }

        pageToken = response.nextPageToken;
        if (!pageToken) break;

        // Places rejects a page token used too soon after the previous page.
        await sleep(2000);
      }
    }
  }

  private async post(body: Record<string, unknown>): Promise<PlacesResponse> {
    let lastError: ProviderError | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": this.apiKey,
            "X-Goog-FieldMask": FIELD_MASK,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        lastError = new ProviderError(`Places unreachable: ${(err as Error).message}`, this.slug, true);
        await sleep(1000 * 2 ** attempt);
        continue;
      }

      if (response.ok) return (await response.json()) as PlacesResponse;

      const text = await response.text().catch(() => "");

      // 429 and 5xx are worth waiting out. 400/403 are a wrong key, a
      // disabled API or unbilled project — retrying those just burns the run
      // and hides the real cause, so they fail immediately with the body,
      // which is where Google actually explains itself.
      if (response.status === 429 || response.status >= 500) {
        lastError = new ProviderError(
          `Places ${response.status}: ${text.slice(0, 200)}`,
          this.slug,
          true,
          response.status,
        );
        await sleep(2000 * 2 ** attempt);
        continue;
      }

      throw new ProviderError(
        `Places ${response.status}: ${text.slice(0, 400)}`,
        this.slug,
        false,
        response.status,
      );
    }

    throw lastError ?? new ProviderError("Places failed", this.slug, true);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
