import { matchKeys, type MatchKeys } from "./dedup";

/**
 * CSV import.
 *
 * The zero-integration lead source, and the one Phase 1 actually runs on. It
 * lets the whole pipeline be proven against fifty real Dubai dental clinics
 * before any discovery API key exists — and a hand-built list of fifty is
 * better than an automated list of five hundred while the prompts are still
 * being tuned.
 *
 * The parser is written out rather than pulled in because the input is a file
 * a person exported from Google Sheets or Apollo, which means quoted fields,
 * embedded commas, embedded newlines and a BOM — and a dependency that handles
 * those is 40kB to avoid 60 lines.
 */

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * RFC 4180-ish. Handles quotes, escaped quotes, embedded newlines, CRLF and a
 * leading BOM. Auto-detects comma, semicolon or tab as the delimiter, because
 * a European Excel export is semicolon-separated and silently parsing it as
 * one column is a confusing failure.
 */
export function parseCsv(text: string): string[][] {
  // Excel writes a BOM; unstripped it becomes part of the first header name
  // and every column mapping for that file silently misses.
  let input = text.replace(/^﻿/, "");
  if (!input.trim()) return [];

  const delimiter = detectDelimiter(input);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // Handled by the \n that follows; a lone \r is a classic-Mac line end.
      if (input[i + 1] !== "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
    } else {
      field += ch;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Trailing newline produces one empty row; a spreadsheet with blank lines in
  // the middle produces more. None of them are companies.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function detectDelimiter(input: string): string {
  const firstLine = input.slice(0, input.indexOf("\n") === -1 ? input.length : input.indexOf("\n"));
  const counts = [
    { d: ",", n: (firstLine.match(/,/g) ?? []).length },
    { d: ";", n: (firstLine.match(/;/g) ?? []).length },
    { d: "\t", n: (firstLine.match(/\t/g) ?? []).length },
  ];
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ",";
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

export const IMPORT_FIELDS = [
  "name",
  "website",
  "phone",
  "email",
  "city",
  "address",
  "country_code",
  "vertical_slug",
  "rating",
  "review_count",
  "location_count",
  "booking_url",
  "company_size",
  "source_url",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/**
 * Header aliases, so the common exports map themselves.
 *
 * Google Sheets, Apollo and Places all name these differently, and asking
 * someone to rename fourteen columns by hand before their first import is the
 * kind of friction that stops a tool being used at all.
 */
const ALIASES: Record<ImportField, string[]> = {
  name: ["name", "company", "companyname", "business", "businessname", "title", "organization"],
  website: ["website", "url", "site", "domain", "web", "homepage", "websiteurl"],
  phone: ["phone", "telephone", "tel", "phonenumber", "mobile", "contactnumber", "internationalphonenumber"],
  email: ["email", "emailaddress", "generalemail", "contactemail", "mail"],
  city: ["city", "town", "locality", "emirate", "canton"],
  address: ["address", "fulladdress", "street", "formattedaddress", "location"],
  country_code: ["country", "countrycode", "countryiso"],
  vertical_slug: ["vertical", "category", "industry", "type", "businesstype", "primarytype"],
  rating: ["rating", "googlerating", "stars", "score", "averagerating"],
  review_count: ["reviews", "reviewcount", "numberofreviews", "usertotalratings", "totalratings"],
  location_count: ["locations", "locationcount", "branches", "numberoflocations"],
  booking_url: ["bookingurl", "bookinglink", "booknow", "reservationurl"],
  company_size: ["size", "companysize", "employees", "employeecount", "headcount"],
  source_url: ["sourceurl", "source", "link", "profileurl", "googlemapsurl", "mapsurl"],
};

const normaliseHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Best-guess mapping from a file's headers to our fields. */
export function suggestMapping(headers: string[]): Partial<Record<ImportField, number>> {
  const mapping: Partial<Record<ImportField, number>> = {};
  const seen = new Set<number>();

  for (const field of IMPORT_FIELDS) {
    const aliases = ALIASES[field];
    // Exact alias first, so a file with both "phone" and "mobile" picks
    // "phone" rather than whichever happens to come first.
    for (const alias of aliases) {
      const index = headers.findIndex((h, i) => !seen.has(i) && normaliseHeader(h) === alias);
      if (index !== -1) {
        mapping[field] = index;
        seen.add(index);
        break;
      }
    }
    if (mapping[field] !== undefined) continue;

    const index = headers.findIndex(
      (h, i) => !seen.has(i) && aliases.some((a) => normaliseHeader(h).includes(a)),
    );
    if (index !== -1) {
      mapping[field] = index;
      seen.add(index);
    }
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Rows to companies
// ---------------------------------------------------------------------------

export interface ImportedCompany {
  name: string;
  website: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  address: string | null;
  countryCode: string | null;
  verticalSlug: string | null;
  rating: number | null;
  reviewCount: number | null;
  locationCount: number | null;
  bookingUrl: string | null;
  companySize: string | null;
  sourceUrl: string | null;
  keys: MatchKeys;
  /** 1-based row in the original file, for error reporting. */
  row: number;
}

export interface ImportProblem {
  row: number;
  reason: string;
  raw: string;
}

export interface ImportPlan {
  companies: ImportedCompany[];
  problems: ImportProblem[];
  /** Rows that duplicate an earlier row *within the same file*. */
  duplicatesInFile: { row: number; matches: number; on: string }[];
  headers: string[];
  mapping: Partial<Record<ImportField, number>>;
}

export interface ImportDefaults {
  countryCode?: string;
  verticalSlug?: string;
  city?: string;
}

const num = (v: string | undefined): number | null => {
  if (!v) return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const str = (v: string | undefined): string | null => {
  const t = v?.trim();
  return t && t !== "-" && t.toLowerCase() !== "n/a" ? t : null;
};

/**
 * Turn a parsed file into companies, without touching the database.
 *
 * Separating the plan from the write is what makes the import UI honest: the
 * screen that says "48 companies, 2 skipped, 3 already in the file twice" is
 * showing this, and nothing has been written yet.
 */
export function planImport(
  rows: string[][],
  mapping: Partial<Record<ImportField, number>>,
  defaults: ImportDefaults = {},
): ImportPlan {
  const [headers = [], ...body] = rows;
  const companies: ImportedCompany[] = [];
  const problems: ImportProblem[] = [];
  const duplicatesInFile: { row: number; matches: number; on: string }[] = [];

  const pick = (row: string[], field: ImportField): string | undefined => {
    const index = mapping[field];
    return index === undefined ? undefined : row[index];
  };

  body.forEach((row, i) => {
    // +2: one for the header, one because humans count from 1.
    const rowNumber = i + 2;
    const name = str(pick(row, "name"));

    if (!name) {
      problems.push({ row: rowNumber, reason: "no company name", raw: row.join(" | ").slice(0, 120) });
      return;
    }

    const countryCode =
      (str(pick(row, "country_code")) ?? defaults.countryCode ?? null)?.toUpperCase().slice(0, 2) ??
      null;

    const company: ImportedCompany = {
      name,
      website: str(pick(row, "website")),
      phone: str(pick(row, "phone")),
      email: str(pick(row, "email"))?.toLowerCase() ?? null,
      city: str(pick(row, "city")) ?? defaults.city ?? null,
      address: str(pick(row, "address")),
      countryCode,
      verticalSlug: str(pick(row, "vertical_slug")) ?? defaults.verticalSlug ?? null,
      rating: num(pick(row, "rating")),
      reviewCount: num(pick(row, "review_count")),
      locationCount: num(pick(row, "location_count")),
      bookingUrl: str(pick(row, "booking_url")),
      companySize: str(pick(row, "company_size")),
      sourceUrl: str(pick(row, "source_url")),
      keys: { domain: null, phoneE164: null, nameKey: null, namePlaceKey: null },
      row: rowNumber,
    };

    company.keys = matchKeys({
      name: company.name,
      website: company.website,
      phone: company.phone,
      countryCode: company.countryCode,
      city: company.city,
    });

    // Contactable at all? A company with no website, no phone and no email
    // cannot be researched or reached, and importing it only inflates a count.
    if (!company.website && !company.phone && !company.email) {
      problems.push({
        row: rowNumber,
        reason: "no website, phone or email — nothing to reach them by",
        raw: name,
      });
      return;
    }

    const earlier = companies.find((c) => {
      if (c.keys.domain && company.keys.domain && c.keys.domain === company.keys.domain) return true;
      if (c.keys.phoneE164 && company.keys.phoneE164 && c.keys.phoneE164 === company.keys.phoneE164)
        return true;
      return Boolean(
        c.keys.namePlaceKey &&
          company.keys.namePlaceKey &&
          c.keys.namePlaceKey === company.keys.namePlaceKey,
      );
    });

    if (earlier) {
      duplicatesInFile.push({
        row: rowNumber,
        matches: earlier.row,
        on:
          earlier.keys.domain === company.keys.domain && company.keys.domain
            ? "website"
            : earlier.keys.phoneE164 === company.keys.phoneE164 && company.keys.phoneE164
              ? "phone"
              : "name and city",
      });
      return;
    }

    companies.push(company);
  });

  return { companies, problems, duplicatesInFile, headers, mapping };
}
