import type pg from "pg";
import { isUniqueViolation } from "../client";
import { matchKeys, mergeFill, type MatchStrength } from "../../discovery/dedup";

/**
 * Companies, and the dedup that keeps one business to one row.
 *
 * Every write goes through `upsert`, which resolves the three match keys
 * before inserting. The database backs this with unique indexes on domain and
 * normalised phone, so two workers racing on the same company produce a
 * constraint violation rather than two rows — and the violation is *handled*,
 * not surfaced, because it is an ordinary outcome of concurrent discovery.
 */

export interface CompanyInput {
  name: string;
  legalName?: string | null;
  verticalSlug?: string | null;
  countryCode?: string | null;
  city?: string | null;
  address?: string | null;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  companySize?: string | null;
  locationCount?: number | null;
  rating?: number | null;
  reviewCount?: number | null;
  bookingUrl?: string | null;
  bookingProvider?: string | null;
  hasWhatsapp?: boolean | null;
  contactWorkflow?: string | null;
  sourceSlug: string;
  sourceUrl?: string | null;
}

export interface CompanyRow {
  id: number;
  name: string;
  domain: string | null;
  phone_e164: string | null;
  email: string | null;
  country_code: string | null;
  city: string | null;
  vertical_slug: string | null;
  website: string | null;
  status: string;
  sources: { slug: string; url?: string; at: string }[];
  /**
   * These queries `select *`, so a row carries every column — including the
   * dozen fill-merged ones it would be noise to redeclare here. The index
   * signature says so honestly rather than being cast away at each use.
   */
  [column: string]: unknown;
}

export interface UpsertResult {
  company: CompanyRow;
  created: boolean;
  /** How it matched an existing row, when it did. */
  mergedOn: MatchStrength;
}

/** The columns fill-merging is allowed to touch. */
const FILLABLE = [
  "legal_name",
  "vertical_slug",
  "country_code",
  "city",
  "address",
  "website",
  "domain",
  "phone",
  "phone_e164",
  "email",
  "company_size",
  "location_count",
  "rating",
  "review_count",
  "booking_url",
  "booking_provider",
  "has_whatsapp",
  "contact_workflow",
] as const;

function toColumns(input: CompanyInput) {
  const keys = matchKeys({
    name: input.name,
    website: input.website,
    phone: input.phone,
    countryCode: input.countryCode,
    city: input.city,
  });
  return {
    keys,
    values: {
      legal_name: input.legalName ?? null,
      vertical_slug: input.verticalSlug ?? null,
      country_code: input.countryCode?.toUpperCase() ?? null,
      city: input.city ?? null,
      address: input.address ?? null,
      website: input.website ?? null,
      domain: keys.domain,
      phone: input.phone ?? null,
      phone_e164: keys.phoneE164,
      email: input.email?.toLowerCase() ?? null,
      company_size: input.companySize ?? null,
      location_count: input.locationCount ?? null,
      rating: input.rating ?? null,
      review_count: input.reviewCount ?? null,
      booking_url: input.bookingUrl ?? null,
      booking_provider: input.bookingProvider ?? null,
      has_whatsapp: input.hasWhatsapp ?? null,
      contact_workflow: input.contactWorkflow ?? null,
    } as Record<string, unknown>,
  };
}

/**
 * Find an existing company by the three keys, strongest first.
 *
 * The name key is scoped to country and city and checked last, because
 * "Dental Clinic" in Dubai is not one business. It is also the only key not
 * backed by a unique index — two rows *can* legitimately share it, so this
 * takes the oldest match rather than asserting there is one.
 */
export async function findByKeys(
  c: pg.PoolClient,
  keys: ReturnType<typeof matchKeys>,
): Promise<CompanyRow | undefined> {
  if (keys.domain) {
    const byDomain = await c.query<CompanyRow>(
      `select * from sales.company where domain = $1 limit 1`,
      [keys.domain],
    );
    if (byDomain.rows[0]) return byDomain.rows[0];
  }
  if (keys.phoneE164) {
    const byPhone = await c.query<CompanyRow>(
      `select * from sales.company where phone_e164 = $1 limit 1`,
      [keys.phoneE164],
    );
    if (byPhone.rows[0]) return byPhone.rows[0];
  }
  if (keys.namePlaceKey) {
    const [country, city, nameKey] = keys.namePlaceKey.split(":");
    const byName = await c.query<CompanyRow>(
      `select * from sales.company
        where country_code = $1
          and coalesce(regexp_replace(lower(city), '[^a-z0-9]', '', 'g'), '') = $2
          and lower(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g')) like $3
        order by id limit 1`,
      // The stored name is not pre-normalised the way `normaliseName` does it
      // (that strips legal suffixes and generic words), so this is a
      // deliberately loose prefix probe. Exactness is the job of the two keys
      // above; this one only has to be right often enough to be worth running.
      [country, city, `%${nameKey.slice(0, 12)}%`],
    );
    if (byName.rows[0]) return byName.rows[0];
  }
  return undefined;
}

export async function upsert(c: pg.PoolClient, input: CompanyInput): Promise<UpsertResult> {
  const { keys, values } = toColumns(input);
  const sourceEntry = {
    slug: input.sourceSlug,
    url: input.sourceUrl ?? undefined,
    at: new Date().toISOString(),
  };

  const existing = await findByKeys(c, keys);

  if (existing) {
    const current: Record<string, unknown> = Object.fromEntries(
      FILLABLE.map((k) => [k, existing[k] ?? null]),
    );
    const merged = mergeFill(current, values);
    const sets = FILLABLE.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const updated = await c.query<CompanyRow>(
      `update sales.company
          set ${sets},
              sources = sources || $${FILLABLE.length + 2}::jsonb,
              updated_at = now()
        where id = $1
        returning *`,
      [existing.id, ...FILLABLE.map((k) => merged[k] ?? null), JSON.stringify([sourceEntry])],
    );
    return {
      company: updated.rows[0],
      created: false,
      mergedOn: keys.domain && existing.domain === keys.domain
        ? "domain"
        : keys.phoneE164 && existing.phone_e164 === keys.phoneE164
          ? "phone"
          : "name_place",
    };
  }

  const columns = ["name", ...FILLABLE];
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");

  try {
    const inserted = await c.query<CompanyRow>(
      `insert into sales.company (${columns.join(", ")}, sources)
       values (${placeholders}, $${columns.length + 1}::jsonb)
       returning *`,
      [input.name, ...FILLABLE.map((k) => values[k] ?? null), JSON.stringify([sourceEntry])],
    );
    return { company: inserted.rows[0], created: true, mergedOn: null };
  } catch (err) {
    // Another worker inserted the same company between our lookup and our
    // insert. Not an error — discovery is concurrent by design. Re-read and
    // merge into whatever they wrote.
    if (isUniqueViolation(err)) {
      const now = await findByKeys(c, keys);
      if (now) {
        return { company: now, created: false, mergedOn: keys.domain ? "domain" : "phone" };
      }
    }
    throw err;
  }
}

export async function get(c: pg.PoolClient, id: number): Promise<CompanyRow | undefined> {
  const rows = await c.query<CompanyRow>(`select * from sales.company where id = $1`, [id]);
  return rows.rows[0];
}
