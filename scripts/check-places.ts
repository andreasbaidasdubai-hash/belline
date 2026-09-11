/**
 * Google Places connector — mapping and query construction.
 *
 * No key, no network, no database. Everything here is the pure half of the
 * connector, which is also the half that decides what a lead *is*: a bad
 * mapping produces a plausible company row with the wrong phone number, and
 * nothing downstream can tell.
 *
 *   npm run check:places
 */

import assert from "node:assert";
import { buildQueries, toRawCompany } from "../src/lib/sales/discovery/google-places";
import { matchKeys } from "../src/lib/sales/discovery/dedup";

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

const ctx = { countryCode: "AE", verticalSlug: "dentists", city: "Dubai" };

/** A realistic Places (New) result. */
const PLACE = {
  id: "ChIJ_____EXAMPLE",
  displayName: { text: "Smile Dental Clinic" },
  formattedAddress: "Unit 4, Jumeirah Beach Road, Dubai, UAE",
  shortFormattedAddress: "Jumeirah Beach Road, Dubai",
  location: { latitude: 25.2048, longitude: 55.2708 },
  types: ["dentist", "health", "point_of_interest"],
  primaryType: "dentist",
  businessStatus: "OPERATIONAL",
  googleMapsUri: "https://maps.google.com/?cid=123",
  rating: 4.6,
  userRatingCount: 312,
  internationalPhoneNumber: "+971 4 123 4567",
  websiteUri: "https://www.smiledental.ae/",
  regularOpeningHours: { weekdayDescriptions: ["Monday: 9:00 AM – 9:00 PM"], openNow: true },
};

console.log("\n  Mapping\n");

test("a normal result maps to a company", () => {
  const c = toRawCompany(PLACE, ctx);
  assert.ok(c);
  assert.strictEqual(c.name, "Smile Dental Clinic");
  assert.strictEqual(c.website, "https://www.smiledental.ae/");
  assert.strictEqual(c.phone, "+971 4 123 4567");
  assert.strictEqual(c.rating, 4.6);
  assert.strictEqual(c.reviewCount, 312);
  assert.strictEqual(c.externalId, "ChIJ_____EXAMPLE");
  assert.strictEqual(c.countryCode, "AE");
  assert.strictEqual(c.verticalSlug, "dentists");
  assert.strictEqual(c.city, "Dubai");
});

test("Google's own category becomes the sub-vertical", () => {
  assert.strictEqual(toRawCompany(PLACE, ctx)!.subVertical, "dentist");
  const noPrimary = { ...PLACE, primaryType: undefined };
  assert.strictEqual(toRawCompany(noPrimary, ctx)!.subVertical, "dentist");
});

test("a permanently closed business is dropped, not imported", () => {
  // Dropping here rather than at scoring is the difference between a wasted
  // row and a wasted research call.
  const closed = { ...PLACE, businessStatus: "CLOSED_PERMANENTLY" };
  assert.strictEqual(toRawCompany(closed, ctx), null);
});

test("a temporarily closed business is kept but flagged", () => {
  const temp = { ...PLACE, businessStatus: "CLOSED_TEMPORARILY" };
  const c = toRawCompany(temp, ctx);
  assert.ok(c);
  assert.strictEqual(c.status, "closed");
});

test("a result with no name is dropped", () => {
  assert.strictEqual(toRawCompany({ ...PLACE, displayName: undefined }, ctx), null);
  assert.strictEqual(toRawCompany({ ...PLACE, displayName: { text: "  " } }, ctx), null);
});

test("missing optional fields become null, never zero or false", () => {
  // The scoring model treats null as "could not tell" and 0 as "none". A
  // clinic with no rating yet must not score as a clinic rated zero.
  const bare = { id: "x", displayName: { text: "Bare Clinic" }, businessStatus: "OPERATIONAL" };
  const c = toRawCompany(bare, ctx);
  assert.ok(c);
  assert.strictEqual(c.rating, null);
  assert.strictEqual(c.reviewCount, null);
  assert.strictEqual(c.website, null);
  assert.strictEqual(c.phone, null);
});

test("a genuine zero review count survives as zero", () => {
  const c = toRawCompany({ ...PLACE, userRatingCount: 0, rating: undefined }, ctx);
  assert.strictEqual(c!.reviewCount, 0, "0 reviews is a fact, not a missing value");
  assert.strictEqual(c!.rating, null);
});

console.log("\n  Handing off to dedup\n");

test("the mapped phone and website produce the right match keys", () => {
  const c = toRawCompany(PLACE, ctx)!;
  const keys = matchKeys({
    name: c.name,
    website: c.website,
    phone: c.phone,
    countryCode: c.countryCode,
    city: c.city,
  });
  assert.strictEqual(keys.domain, "smiledental.ae");
  // Places returns a spaced international format; the UAE landline is 8
  // national digits, which is the case that was broken before.
  assert.strictEqual(keys.phoneE164, "+97141234567");
});

test("two Places results for one clinic dedupe against each other", () => {
  const a = toRawCompany(PLACE, ctx)!;
  const b = toRawCompany({ ...PLACE, id: "ChIJ_OTHER", displayName: { text: "Smile Dental" } }, ctx)!;
  const ka = matchKeys({ name: a.name, website: a.website, phone: a.phone, countryCode: "AE", city: "Dubai" });
  const kb = matchKeys({ name: b.name, website: b.website, phone: b.phone, countryCode: "AE", city: "Dubai" });
  assert.strictEqual(ka.domain, kb.domain);
});

console.log("\n  Query construction\n");

const query = {
  countryCode: "AE",
  regions: ["Dubai", "Abu Dhabi"],
  verticalSlug: "dentists",
  searchTerms: ["dental clinic", "dentist"],
  limit: 50,
};

test("one query per region per term", () => {
  const queries = buildQueries(query);
  assert.strictEqual(queries.length, 4);
  assert.deepStrictEqual(
    queries.map((q) => q.text),
    ["dental clinic in Dubai", "dentist in Dubai", "dental clinic in Abu Dhabi", "dentist in Abu Dhabi"],
  );
});

test("each query carries its city, so results are attributed correctly", () => {
  const queries = buildQueries(query);
  assert.strictEqual(queries[0].city, "Dubai");
  assert.strictEqual(queries[3].city, "Abu Dhabi");
});

test("no regions still produces a usable query", () => {
  const queries = buildQueries({ ...query, regions: [] });
  assert.deepStrictEqual(queries.map((q) => q.text), ["dental clinic", "dentist"]);
  assert.strictEqual(queries[0].city, "");
});

test("no vertical is named in the connector — terms come from config", () => {
  // The directive is explicit: do not hardcode the system around one industry.
  const physio = buildQueries({ ...query, searchTerms: ["physiotherapy clinic"], regions: ["Zug"] });
  assert.deepStrictEqual(physio.map((q) => q.text), ["physiotherapy clinic in Zug"]);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
