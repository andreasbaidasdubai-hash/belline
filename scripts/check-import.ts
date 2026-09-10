/**
 * Dedup and CSV import.
 *
 * Pure logic, no database, no keys. Worth the coverage because both failure
 * directions are silent and expensive: a false match merges two real
 * businesses into one — losing a prospect and putting the wrong company's
 * facts in front of a person — and a missed match sends the same clinic two
 * emails from two agents.
 *
 *   npm run check:import
 */

import assert from "node:assert";
import {
  compare,
  matchKeys,
  mergeFill,
  normaliseDomain,
  normaliseName,
  normalisePhone,
} from "../src/lib/sales/discovery/dedup";
import { parseCsv, planImport, suggestMapping } from "../src/lib/sales/discovery/csv";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("\n  Domain normalisation\n");

test("scheme, www, path and query all fall away", () => {
  const expected = "smiledental.ae";
  for (const input of [
    "https://www.smiledental.ae",
    "http://smiledental.ae/",
    "smiledental.ae",
    "WWW.SmileDental.AE",
    "https://www.smiledental.ae/book?utm_source=google#top",
    "https://smiledental.ae:443/contact",
  ]) {
    assert.strictEqual(normaliseDomain(input), expected, `failed on ${input}`);
  }
});

test("a subdomain is kept — clinics really do live on one", () => {
  assert.strictEqual(normaliseDomain("https://dubai.smiledental.ae"), "dubai.smiledental.ae");
});

test("shared platforms never become a company key", () => {
  // A hundred clinics whose only web presence is Facebook must not merge into
  // one company. This is the single most damaging false-match available.
  for (const input of [
    "https://www.facebook.com/smiledental",
    "https://instagram.com/smiledental",
    "https://wa.me/971501234567",
    "https://linktr.ee/smiledental",
    "https://smiledental.wixsite.com/home",
  ]) {
    assert.strictEqual(normaliseDomain(input), null, `${input} should not be a key`);
  }
});

test("junk cells produce no key", () => {
  for (const input of ["", "  ", "n/a", "-", "none", "not a url", "localhost", null, undefined]) {
    assert.strictEqual(normaliseDomain(input), null, `failed on ${JSON.stringify(input)}`);
  }
});

console.log("\n  Phone normalisation\n");

test("UAE numbers reach one E.164 form", () => {
  const expected = "+971501234567";
  for (const input of [
    "+971 50 123 4567",
    "00971501234567",
    "050 123 4567",
    "0501234567",
    "971501234567",
    "+971-50-123-4567",
    "(050) 123 4567",
    "tel:+971501234567",
  ]) {
    assert.strictEqual(normalisePhone(input, "AE"), expected, `failed on "${input}"`);
  }
});

test("a UAE landline normalises too", () => {
  assert.strictEqual(normalisePhone("04 123 4567", "AE"), "+97141234567");
});

test("Saudi and Swiss numbers use their own plans", () => {
  assert.strictEqual(normalisePhone("055 123 4567", "SA"), "+966551234567");
  assert.strictEqual(normalisePhone("+966 55 123 4567", "SA"), "+966551234567");
  assert.strictEqual(normalisePhone("044 123 45 67", "CH"), "+41441234567");
  assert.strictEqual(normalisePhone("+41 79 123 45 67", "CH"), "+41791234567");
});

test("a wrong-length number is rejected rather than guessed at", () => {
  // Half a phone number that still parses is worse than none: it becomes a
  // dedup key that matches the wrong company.
  assert.strictEqual(normalisePhone("1234", "AE"), null);
  assert.strictEqual(normalisePhone("05012345678901", "AE"), null);
});

test("unparseable cells produce null", () => {
  for (const input of ["call us", "+971 4 XXX XXXX", "9.71412e+11", "ext. 204", "", null]) {
    assert.strictEqual(normalisePhone(input, "AE"), null, `failed on ${JSON.stringify(input)}`);
  }
});

test("only the first of several numbers is taken", () => {
  assert.strictEqual(normalisePhone("050 123 4567, 04 999 8888", "AE"), "+971501234567");
  assert.strictEqual(normalisePhone("050 123 4567 / 04 999 8888", "AE"), "+971501234567");
});

test("a foreign number keeps its own country code", () => {
  // A Dubai listing with a UK head-office number must not be rewritten to +971.
  assert.strictEqual(normalisePhone("+44 20 7946 0958", "AE"), "+442079460958");
});

console.log("\n  Name normalisation\n");

test("legal suffixes are stripped", () => {
  const a = normaliseName("Smile Dental Clinic LLC");
  assert.strictEqual(normaliseName("Smile Dental Clinic"), a);
  assert.strictEqual(normaliseName("Smile Dental Clinic FZ-LLC"), a);
  assert.strictEqual(normaliseName("SMILE DENTAL CLINIC L.L.C."), a);
});

test("punctuation, case and accents do not distinguish businesses", () => {
  assert.strictEqual(normaliseName("Zahnärzte Genève"), normaliseName("Zahnarzte Geneve"));
  assert.strictEqual(normaliseName("Dr. Smile & Co."), normaliseName("Dr Smile and Co"));
});

test("a name that is only generic words keeps them", () => {
  // Stripping "dental clinic" to nothing would produce a key matching every
  // clinic in the city — the exact false-merge this guards against.
  const key = normaliseName("The Dental Clinic");
  assert.ok(key && key.length >= 3, "should not reduce to an empty key");
});

test("two different practices do not collide", () => {
  assert.notStrictEqual(normaliseName("Almaya Dental"), normaliseName("Al Noor Dental"));
});

console.log("\n  Matching\n");

const base = matchKeys({
  name: "Smile Dental Clinic LLC",
  website: "https://www.smiledental.ae",
  phone: "+971 50 123 4567",
  countryCode: "AE",
  city: "Dubai",
});

test("the same business from three sources matches on the strongest key", () => {
  const fromDirectory = matchKeys({
    name: "Smile Dental",
    website: "http://smiledental.ae/contact",
    phone: null,
    countryCode: "AE",
    city: "Dubai",
  });
  assert.strictEqual(compare(base, fromDirectory), "domain");

  const fromPlaces = matchKeys({
    name: "Smile Dental Clinic",
    website: null,
    phone: "050 123 4567",
    countryCode: "AE",
    city: "Dubai",
  });
  assert.strictEqual(compare(base, fromPlaces), "phone");

  const nameOnly = matchKeys({
    name: "Smile Dental Clinic",
    website: null,
    phone: null,
    countryCode: "AE",
    city: "Dubai",
  });
  assert.strictEqual(compare(base, nameOnly), "name_place");
});

test("the same name in two countries is two businesses", () => {
  const dubai = matchKeys({ name: "Almaya Clinic", countryCode: "AE", city: "Dubai" });
  const riyadh = matchKeys({ name: "Almaya Clinic", countryCode: "SA", city: "Riyadh" });
  assert.strictEqual(compare(dubai, riyadh), null);
});

test("two companies with nothing in common do not match", () => {
  const other = matchKeys({
    name: "Al Noor Medical Centre",
    website: "https://alnoor.ae",
    phone: "+971 4 555 1234",
    countryCode: "AE",
    city: "Dubai",
  });
  assert.strictEqual(compare(base, other), null);
});

test("merging fills gaps and never overwrites", () => {
  const existing: { name: string; phone: string; email: string | null; rating: number | null } = {
    name: "Smile Dental",
    phone: "+971501234567",
    email: null,
    rating: null,
  };
  const merged = mergeFill(existing, { name: "SMILE DENTAL CLINIC LLC", email: "hi@x.ae", rating: 4.6 });
  assert.strictEqual(merged.name, "Smile Dental", "an existing value must survive a new source");
  assert.strictEqual(merged.email, "hi@x.ae");
  assert.strictEqual(merged.rating, 4.6);
});

console.log("\n  CSV parsing\n");

test("quotes, embedded commas and newlines survive", () => {
  const rows = parseCsv('name,address\n"Smile, Dental","Unit 4\nDubai"\n');
  assert.deepStrictEqual(rows, [
    ["name", "address"],
    ["Smile, Dental", "Unit 4\nDubai"],
  ]);
});

test("escaped quotes come through", () => {
  const rows = parseCsv('name\n"The ""Best"" Clinic"\n');
  assert.strictEqual(rows[1][0], 'The "Best" Clinic');
});

test("a BOM does not poison the first header", () => {
  // Unstripped, the first column becomes "﻿name" and every mapping for
  // that file silently misses — the classic Excel import failure.
  const rows = parseCsv("﻿name,phone\nSmile,050 123 4567\n");
  assert.strictEqual(rows[0][0], "name");
  assert.strictEqual(suggestMapping(rows[0]).name, 0);
});

test("semicolon and tab files are detected", () => {
  assert.deepStrictEqual(parseCsv("name;city\nSmile;Dubai")[1], ["Smile", "Dubai"]);
  assert.deepStrictEqual(parseCsv("name\tcity\nSmile\tDubai")[1], ["Smile", "Dubai"]);
});

test("CRLF and blank lines are handled", () => {
  const rows = parseCsv("name,city\r\nSmile,Dubai\r\n\r\nAlmaya,Dubai\r\n");
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[2], ["Almaya", "Dubai"]);
});

console.log("\n  Column mapping\n");

test("common export headers map themselves", () => {
  const m = suggestMapping(["Company Name", "Website URL", "Phone Number", "City", "Google Rating"]);
  assert.strictEqual(m.name, 0);
  assert.strictEqual(m.website, 1);
  assert.strictEqual(m.phone, 2);
  assert.strictEqual(m.city, 3);
  assert.strictEqual(m.rating, 4);
});

test("an exact alias beats a fuzzy one", () => {
  const m = suggestMapping(["Mobile", "Phone"]);
  assert.strictEqual(m.phone, 1, "'Phone' should win over 'Mobile'");
});

test("one column is never claimed by two fields", () => {
  const m = suggestMapping(["name", "website", "phone"]);
  const used = Object.values(m);
  assert.strictEqual(new Set(used).size, used.length);
});

console.log("\n  Import plan\n");

const FILE = `Company Name,Website,Phone,City,Google Rating,Reviews
Smile Dental Clinic LLC,https://www.smiledental.ae,+971 50 123 4567,Dubai,4.6,312
Smile Dental,http://smiledental.ae/contact,,Dubai,4.6,312
Al Noor Medical Centre,https://alnoor.ae,04 555 1234,Dubai,4.2,88
,https://ghost.ae,050 999 8888,Dubai,,
No Contact Clinic,,,Dubai,3.9,12
Almaya Dental,https://almaya.ae,050 777 6666,Abu Dhabi,4.8,540
`;

const rows = parseCsv(FILE);
const plan = planImport(rows, suggestMapping(rows[0]), {
  countryCode: "AE",
  verticalSlug: "dentists",
});

test("valid rows become companies", () => {
  assert.strictEqual(plan.companies.length, 3, JSON.stringify(plan.companies.map((c) => c.name)));
  assert.deepStrictEqual(
    plan.companies.map((c) => c.name),
    ["Smile Dental Clinic LLC", "Al Noor Medical Centre", "Almaya Dental"],
  );
});

test("a duplicate inside the same file is caught before any write", () => {
  assert.strictEqual(plan.duplicatesInFile.length, 1);
  assert.strictEqual(plan.duplicatesInFile[0].row, 3);
  assert.strictEqual(plan.duplicatesInFile[0].matches, 2);
  assert.strictEqual(plan.duplicatesInFile[0].on, "website");
});

test("a nameless row is reported, not imported", () => {
  assert.ok(plan.problems.some((p) => p.row === 5 && /no company name/.test(p.reason)));
});

test("an unreachable company is reported, not imported", () => {
  assert.ok(plan.problems.some((p) => p.row === 6 && /nothing to reach them by/.test(p.reason)));
});

test("defaults fill country and vertical", () => {
  assert.ok(plan.companies.every((c) => c.countryCode === "AE"));
  assert.ok(plan.companies.every((c) => c.verticalSlug === "dentists"));
});

test("numbers are parsed and phones normalised", () => {
  const smile = plan.companies[0];
  assert.strictEqual(smile.rating, 4.6);
  assert.strictEqual(smile.reviewCount, 312);
  assert.strictEqual(smile.keys.phoneE164, "+971501234567");
  assert.strictEqual(smile.keys.domain, "smiledental.ae");
});

test("planning writes nothing — it is a plan", () => {
  // The property the import screen depends on: "48 companies, 2 skipped" is
  // shown before anything is committed.
  const again = planImport(rows, suggestMapping(rows[0]), { countryCode: "AE" });
  assert.strictEqual(again.companies.length, plan.companies.length);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
