/**
 * The enquiry form.
 *
 * This is the only place a stranger writes into the product, and the only
 * lead capture we have — so it is tested from both ends: nothing hostile gets
 * in, and nothing real gets turned away.
 *
 * The email checks carry most of the weight. A mistyped domain passes every
 * syntax test ever written and the reply then vanishes with no bounce anyone
 * reads, which for a form whose entire job is to produce a reply is a total
 * failure that looks exactly like success.
 *
 *   npm run check:leads
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-leads-"));

const { checkShape, suggest, verify } = await import("../src/lib/leads/email");
const { MARKETS } = await import("../src/lib/markets");
const { buildLead, normalisePhone, findRecentDuplicate } = await import("../src/lib/leads");

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  const run = async () => {
    try {
      await fn();
      console.log(`  [32m✓[0m ${name}`);
      passed++;
    } catch (err) {
      console.log(`  [31m✗[0m ${name}`);
      console.log(`      ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  };
  queue = queue.then(run);
}

let queue: Promise<void> = Promise.resolve();

console.log("\nEmail shape\n");

test("an ordinary address is accepted", () => {
  assert.equal(checkShape("andreas@belline.ai").valid, true);
});

test("the address is normalised, so the same person is one person", () => {
  assert.equal(checkShape("  Andreas@Belline.AI ").email, "andreas@belline.ai");
});

test("no @ is refused", () => {
  assert.equal(checkShape("andreas.belline.ai").valid, false);
});

test("a bare domain with no TLD is refused", () => {
  assert.equal(checkShape("andreas@localhost").valid, false);
});

test("two dots in a row are refused", () => {
  assert.equal(checkShape("andreas..b@gmail.com").valid, false);
});

test("a throwaway mailbox is refused, and told why", () => {
  const check = checkShape("someone@mailinator.com");
  assert.equal(check.valid, false);
  assert.equal(check.disposable, true);
  assert.match(check.reason!, /temporary mailbox/i);
});

test("a shared mailbox is accepted but flagged as one", () => {
  const check = checkShape("info@someclinic.ae");
  assert.equal(check.valid, true);
  assert.equal(check.role, true, "info@ was not recognised as a shared mailbox");
});

console.log("\nSpelling — the failure that looks like success\n");

for (const [typo, meant] of [
  ["a@gmial.com", "a@gmail.com"],
  ["a@gmai.com", "a@gmail.com"],
  ["a@hotmial.com", "a@hotmail.com"],
  ["a@outlok.com", "a@outlook.com"],
  ["a@yahooo.com", "a@yahoo.com"],
  ["a@iclould.com", "a@icloud.com"],
] as const) {
  test(`${typo} is offered ${meant}`, () => {
    assert.equal(suggest(typo), meant);
  });
}

test("a correctly spelled famous domain is not second-guessed", () => {
  assert.equal(suggest("a@gmail.com"), null);
});

test("a company's own domain is left alone", () => {
  // The failure mode that matters here: telling a real business its own
  // address is wrong. Nothing within one edit of a known provider.
  assert.equal(suggest("andreas@azuretable.ae"), null);
  assert.equal(suggest("reception@lumiere-zurich.ch"), null);
});

test("a suggestion is never a refusal", () => {
  const check = checkShape("a@gmial.com");
  assert.equal(check.valid, true, "a spelling suggestion refused the address outright");
  assert.equal(check.suggestion, "a@gmail.com");
});

console.log("\nDeliverability\n");

test("a domain that cannot exist is refused", async () => {
  const check = await verify("someone@this-domain-does-not-exist-belline-test.invalid");
  assert.equal(check.valid, false, "a non-existent domain was accepted");
  assert.equal(check.mx, false);
  assert.match(check.reason!, /no domain|cannot receive/i);
});

test("a real domain passes, or is left unjudged when DNS is unreachable", async () => {
  const check = await verify("hello@gmail.com");
  // Never false: gmail.com has MX. `null` is the honest answer when the
  // network is down, and it must not fail the address — an outage on our side
  // is not the customer's email being wrong.
  assert.notEqual(check.mx, false, "gmail.com was reported as undeliverable");
  assert.equal(check.valid, true);
});

console.log("\nPhone\n");

test("a UAE mobile typed locally becomes E.164", () => {
  assert.deepEqual(normalisePhone("050 123 4567"), { phone: "+971501234567", valid: true });
});

test("an international number is kept as given", () => {
  assert.deepEqual(normalisePhone("+41 44 555 21 80"), { phone: "+41445552180", valid: true });
});

test("00 is treated as a plus", () => {
  assert.equal(normalisePhone("0044 20 7946 0958").phone, "+442079460958");
});

test("too few digits is refused rather than guessed at", () => {
  assert.equal(normalisePhone("12345").valid, false);
});

test("a number from outside the three countries we prospect in still works", () => {
  // The sales-side normaliser only knows AE, SA and CH. An inbound enquiry can
  // come from anywhere, and refusing one is a lead thrown away.
  assert.equal(normalisePhone("+1 571 778 5920").valid, true);
});

console.log("\nThe whole form\n");

const good = {
  name: "Andreas",
  email: "andreas@gmail.com",
  phone: "+971501234567",
  company: "Azure Table",
  vertical: "Restaurant",
  source: "website: Business",
};

test("a complete enquiry is accepted", async () => {
  const result = await buildLead(good);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
});

test("each required field is named when it is missing", async () => {
  for (const field of ["name", "email", "phone", "company"]) {
    const result = await buildLead({ ...good, [field]: "" });
    assert.equal(result.ok, false, `${field} was allowed to be empty`);
    if (!result.ok) assert.equal(result.field, field);
  }
});

test("a near-miss domain is asked about rather than silently accepted", async () => {
  // gmial.com is a registered typosquat: it resolves, mail is delivered to
  // somebody else, nothing bounces, and the lead is lost invisibly. Accepting
  // it without asking is the worst of the three options.
  const result = await buildLead({ ...good, email: "andreas@gmial.com" });
  assert.equal(result.ok, false, "a known typosquat was accepted without a word");
  if (!result.ok) {
    assert.equal(result.field, "email");
    assert.equal(result.confirmable, true, "the refusal gave them no way past it");
    assert.equal(result.suggestion, "andreas@gmail.com");
  }
});

test("and is accepted once they say they meant it", async () => {
  const result = await buildLead({
    ...good,
    email: "andreas@gmial.com",
    emailConfirmed: "1",
  });
  assert.equal(result.ok, true, "confirming their own address still would not go through");
  if (result.ok) assert.equal(result.lead.email, "andreas@gmial.com");
});

test("an ordinary company address is never questioned on spelling", async () => {
  // Asserted on the spelling challenge specifically rather than on overall
  // acceptance: azuretable.ae is a made-up domain, so a DNS refusal here is
  // the engine working, and a test that cannot tell those apart is no test.
  const result = await buildLead({ ...good, email: "reception@azuretable.ae" });
  if (!result.ok) {
    assert.notEqual(
      result.confirmable,
      true,
      "a normal company address was queried as a possible typo",
    );
  }
});

test("the honeypot is refused, and separately from a real error", async () => {
  const result = await buildLead({ ...good, website2: "http://spam.example" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.field, "website2");
});

test("oversized input is cut, not rejected", async () => {
  const result = await buildLead({ ...good, notes: "x".repeat(50_000) });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.lead.notes!.length, 2000);
});

test("control characters are stripped", async () => {
  const result = await buildLead({ ...good, company: "Azure Table" });
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(!/[ -]/.test(result.lead.company));
});

test("the same person filling it in twice is one enquiry", async () => {
  const first = await buildLead(good);
  const second = await buildLead({ ...good, notes: "Forgot to say — two venues." });
  assert.ok(first.ok && second.ok);
  if (first.ok && second.ok) {
    assert.ok(
      findRecentDuplicate([first.lead], second.lead),
      "a second submission from the same address was not recognised",
    );
  }
});

test("a different person from the same company is not a duplicate", async () => {
  const first = await buildLead(good);
  const second = await buildLead({ ...good, email: "manager@gmail.com" });
  assert.ok(first.ok && second.ok);
  if (first.ok && second.ok) {
    assert.equal(findRecentDuplicate([first.lead], second.lead), undefined);
  }
});

test("an enquiry from last week is not a duplicate of one today", async () => {
  const first = await buildLead(good);
  const second = await buildLead(good);
  assert.ok(first.ok && second.ok);
  if (first.ok && second.ok) {
    const old = { ...first.lead, createdAt: new Date(Date.now() - 8 * 864e5).toISOString() };
    assert.equal(findRecentDuplicate([old], second.lead), undefined);
  }
});

test("what the form captured is kept, so whoever rings back has the context", async () => {
  const result = await buildLead({
    ...good,
    venues: "Two to five",
    callVolume: "30 to 80",
    availability: "Weekday mornings",
    timezone: "Asia/Dubai",
    website: "azuretable.ae",
  });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.lead.venues, "Two to five");
    assert.equal(result.lead.callVolume, "30 to 80");
    assert.equal(result.lead.timezone, "Asia/Dubai");
    assert.equal(result.lead.source, "website: Business");
    assert.equal(result.lead.status, "new");
  }
});

console.log("\nThe form can actually reach us\n");

test("every origin the site fetches is allowed by the site's CSP", () => {
  // This one nearly shipped. The marketing site is served from belline.ai with
  // `connect-src 'self'`, and the form posts to app.belline.ai — so the browser
  // would have blocked every submission, in production only, with nothing
  // wrong locally and no error anybody would see but the visitor.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const js = fs.readFileSync(path.join(root, "public", "site.js"), "utf8");
  const config = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));

  const csp: string = config.headers
    .flatMap((h: { headers: { key: string; value: string }[] }) => h.headers)
    .find((h: { key: string }) => h.key === "Content-Security-Policy")?.value ?? "";

  const connect = csp.split(";").find((d) => d.trim().startsWith("connect-src")) ?? "";

  const origins = [...js.matchAll(/["'](https?:\/\/[^"'/]+)/g)].map((m) => m[1]);
  assert.ok(origins.length > 0, "no absolute fetch origin found — has the form moved?");

  for (const origin of new Set(origins)) {
    assert.ok(
      connect.includes(origin),
      `site.js talks to ${origin}, which connect-src does not allow: ${connect.trim()}`,
    );
  }
});

console.log("\nThe waitlist on the German pages\n");

const waitlist = await import("../src/lib/leads/waitlist");
const store = await import("../src/lib/store");
type EmailCheckT = Awaited<ReturnType<typeof verify>>;

/** A DNS-free checker: shape and spelling as the real one, MX assumed. */
const offline = async (email: string): Promise<EmailCheckT> => {
  const shape = checkShape(email);
  return shape.valid ? { ...shape, mx: true } : shape;
};

const entry = {
  name: "Julia Brandt",
  email: "julia@salon-brandt.de",
  company: "Salon Brandt",
  country: "DE",
  businessType: "salon",
  page: "/de-de",
};

/** The route, with its own store-backed deps and a fresh limiter unless one is given. */
function route(limiter = waitlist.createWaitlistLimiter()) {
  return { limiter, list: store.listLeads, save: (lead: Parameters<typeof store.saveLead>[0]) => void store.saveLead(lead), check: offline };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://app.belline.ai/api/leads/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://www.belline.ai", "x-forwarded-for": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("a complete entry is accepted and stored as a dach-waitlist lead with its country, and nothing else is asked", async () => {
  const res = await waitlist.handleWaitlist(post(entry), route());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.message, /Eine E-Mail schicken wir Ihnen jetzt nicht/);
  const saved = store.listLeads().find((l) => l.email === entry.email);
  assert.ok(saved, "the entry was not stored");
  assert.equal(saved!.source, "dach-waitlist /de-de");
  assert.ok(waitlist.isWaitlistLead(saved!));
  assert.equal(saved!.market, "DE");
  assert.equal(saved!.company, "Salon Brandt");
  assert.equal(saved!.vertical, "salon");
  assert.equal(saved!.phone, "", "a phone number appeared that nobody typed");
  assert.equal(saved!.status, "new");
});

test("it is stored durably: the JSON store on disk has it after a reload", async () => {
  const file = fs.readdirSync(process.env.DATA_DIR!).find((f) => /lead/.test(f));
  const onDisk = fs
    .readdirSync(process.env.DATA_DIR!)
    .map((f) => fs.readFileSync(path.join(process.env.DATA_DIR!, f), "utf8"))
    .join("\n");
  assert.ok(onDisk.includes(entry.email), `not written to ${process.env.DATA_DIR} (${file ?? "no leads file"})`);
});

test("each required field is named in German when it is missing, and the country must be one we are not open in", async () => {
  for (const field of ["name", "email", "company", "country"]) {
    // The country stays DE: it is what chooses the language, so a German
    // page's form gets German errors even while the field being tested is the
    // country itself (an empty country is still a German page's empty field).
    const result = await waitlist.buildWaitlistEntry({ ...entry, [field]: "", ...(field === "country" ? { country: "" } : {}) }, offline);
    assert.equal(result.ok, false, `${field} was allowed to be empty`);
    if (!result.ok) {
      assert.equal(result.field, field);
      if (field !== "country") assert.match(result.error, /Bitte/, `${field}: "${result.error}" is not a German instruction`);
    }
  }
  // A market that is live has a checkout, so it is never a waitlist country.
  for (const country of ["AE", "XX"]) {
    const result = await waitlist.buildWaitlistEntry({ ...entry, country }, offline);
    assert.equal(result.ok, false, `${country} was accepted`);
  }
  for (const country of ["DE", "AT", "CH", "ch", "GB", "IE"]) assert.equal((await waitlist.buildWaitlistEntry({ ...entry, country }, offline)).ok, true, country);
  // Every waitlist country is a market we cannot sell in. The two lists could
  // drift apart in one edit, and the drift would be a form that takes entries
  // for a country the checkout would happily have taken money in.
  for (const country of waitlist.WAITLIST_MARKETS) {
    assert.equal(MARKETS[country].status, "not-yet", `${country} is on the waitlist and on sale at the same time`);
  }
  const odd = await waitlist.buildWaitlistEntry({ ...entry, businessType: "casino" }, offline);
  assert.equal(odd.ok, false, "a business type outside the list was stored");
  assert.equal((await waitlist.buildWaitlistEntry({ ...entry, businessType: "" }, offline)).ok, true, "the business type is optional");
});

/**
 * The location landing pages (scripts/seo/) publish pages for London,
 * Manchester and Dublin, where Belline is not open. They carry this same form
 * with country=GB or IE, and a reader in London must not be answered in
 * German — which is what happened the first time these markets were added,
 * because every sentence in the handler was a German string literal.
 */
test("a London or Dublin entry is taken, answered in English, and filed under its own market and page", async () => {
  const london = { ...entry, email: "sam@londondental.example.com", country: "GB", page: "/ai-receptionist/dental-clinics/london" };
  const bad = await waitlist.buildWaitlistEntry({ ...london, name: "" }, offline);
  assert.ok(!bad.ok && /Please/.test(bad.error), `a GB entry was refused in German: ${bad.ok ? "" : bad.error}`);
  assert.equal((await waitlist.buildWaitlistEntry({ ...london, country: "XX" }, offline)).ok, false);

  const res = await waitlist.handleWaitlist(post(london), route());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.doesNotMatch(body.message, /Wir melden uns/, "a London entry was answered in German");
  assert.match(body.message, /We will write to you/);
  const saved = store.listLeads().find((l) => l.email === london.email);
  assert.ok(saved, "the London entry was not stored");
  assert.equal(saved!.market, "GB");
  // The page is longer than the German pages' twenty characters, and it has to
  // survive: it is the only record of which of thirty landing pages produced
  // the lead.
  assert.equal(saved!.source, `dach-waitlist ${london.page}`);
  assert.ok(waitlist.isWaitlistLead(saved!), "it is not shown on the Enquiries screen as a waitlist entry");
});

test("without JavaScript a London entry gets an English page back, linking only to a page of ours", async () => {
  const res = await waitlist.handleWaitlist(
    post("name=Sam&email=sam2%40londondental.example.com&company=London+Dental&country=GB&page=%2Fai-receptionist%2Fdental-clinics%2Flondon", {
      "content-type": "application/x-www-form-urlencoded",
    }),
    route(),
  );
  const html = await res.text();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /Back to Belline/);
  assert.match(html, /href="https:\/\/belline\.ai\/ai-receptionist\/dental-clinics\/london#waitlist"/);
  // A path we did not write goes to the landing page, never to wherever the
  // request asked to be sent.
  const away = await waitlist.handleWaitlist(
    post("name=Sam&email=sam3%40londondental.example.com&company=X&country=GB&page=https%3A%2F%2Fevil.example", {
      "content-type": "application/x-www-form-urlencoded",
    }),
    route(),
  );
  const awayHtml = await away.text();
  assert.doesNotMatch(awayHtml, /evil\.example/, "the form sent the reader to a page the request chose");
});

test("a bad address says what to fix; a likely typo is asked about once, then accepted", async () => {
  const bad = await waitlist.buildWaitlistEntry({ ...entry, email: "julia.salon-brandt.de" }, offline);
  assert.ok(!bad.ok && bad.field === "email" && /E-Mail-Adresse/.test(bad.error));
  const typo = await waitlist.buildWaitlistEntry({ ...entry, email: "julia@gmial.com" }, offline);
  assert.ok(!typo.ok && typo.confirmable === true && typo.suggestion === "julia@gmail.com", "the typo was not asked about");
  assert.equal((await waitlist.buildWaitlistEntry({ ...entry, email: "julia@gmial.com", emailConfirmed: true }, offline)).ok, true);
  const res = await waitlist.handleWaitlist(post({ ...entry, email: "" }), route());
  assert.equal(res.status, 422);
  assert.equal((await res.json()).field, "email");
});

test("input is bounded, and the honeypot gets a quiet success and stores nothing", async () => {
  const long = await waitlist.buildWaitlistEntry({ ...entry, company: "x".repeat(5000) }, offline);
  assert.ok(long.ok && long.lead.company.length === 160);
  const before = store.listLeads().length;
  const res = await waitlist.handleWaitlist(post({ ...entry, email: "bot@example.org", website2: "http://spam.example" }), route());
  assert.equal(res.status, 200);
  assert.equal(store.listLeads().length, before, "the honeypot entry was stored");
});

test("the same address twice is one entry", async () => {
  const before = store.listLeads().length;
  const res = await waitlist.handleWaitlist(post({ ...entry, company: "Salon Brandt GmbH" }), route());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).duplicate, true);
  assert.equal(store.listLeads().length, before);
});

test("rate limited like signup: five entries an hour from one address, then a German 429", async () => {
  const deps = route();
  for (let i = 0; i < 5; i++) {
    const res = await waitlist.handleWaitlist(post({ ...entry, email: `person${i}@salon-brandt.de` }, { "x-forwarded-for": "198.51.100.9" }), deps);
    assert.equal(res.status, 200, `entry ${i + 1} was refused`);
  }
  const sixth = await waitlist.handleWaitlist(post({ ...entry, email: "person6@salon-brandt.de" }, { "x-forwarded-for": "198.51.100.9" }), deps);
  assert.equal(sixth.status, 429);
  assert.match((await sixth.json()).error, /in einer Stunde/);
  // Somebody else is not caught by it.
  const other = await waitlist.handleWaitlist(post({ ...entry, email: "other@salon-brandt.de" }, { "x-forwarded-for": "198.51.100.10" }), deps);
  assert.equal(other.status, 200);
  const { SIGNUP_LIMITS } = await import("../src/lib/onboarding/limit");
  assert.equal(SIGNUP_LIMITS.maxAccounts, 5, "the signup limit changed; this test counts to five");
});

test("CORS answers Belline's own website origins only, and a browser post from anywhere else is refused", async () => {
  for (const origin of ["https://belline.ai", "https://www.belline.ai", "https://belline-staging.up.railway.app"]) {
    const pre = await waitlist.handleWaitlist(new Request("https://app.belline.ai/api/leads/waitlist", { method: "OPTIONS", headers: { origin } }), route());
    assert.equal(pre.status, 204, origin);
    assert.equal(pre.headers.get("access-control-allow-origin"), origin);
    assert.match(pre.headers.get("access-control-allow-methods") ?? "", /POST/);
  }
  for (const origin of ["https://evil.example", "https://belline.ai.evil.example", "http://belline.ai", "null"]) {
    const pre = await waitlist.handleWaitlist(new Request("https://app.belline.ai/api/leads/waitlist", { method: "OPTIONS", headers: { origin } }), route());
    assert.equal(pre.status, 403, origin);
    assert.equal(pre.headers.get("access-control-allow-origin"), null, `${origin} was allowed`);
    const before = store.listLeads().length;
    const res = await waitlist.handleWaitlist(post({ ...entry, email: "cors@salon-brandt.de" }, { origin }), route());
    assert.equal(res.status, 403, `${origin} could post`);
    assert.equal(store.listLeads().length, before);
  }
  assert.equal(waitlist.waitlistCors("https://www.belline.ai")["access-control-allow-origin"], "https://www.belline.ai");
  assert.equal(waitlist.waitlistCors("*")["access-control-allow-origin"], undefined);
});

test("without JavaScript the form still works: a form post gets a German page back, linking only to a German page", async () => {
  const form = new URLSearchParams({ ...entry, email: "nojs@salon-brandt.de", page: "/de-ch" });
  const res = await waitlist.handleWaitlist(
    new Request("https://app.belline.ai/api/leads/waitlist", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://belline.ai" }, body: form }),
    route(),
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  assert.match(html, /Danke, Sie stehen auf der Warteliste/);
  assert.match(html, /href="https:\/\/belline\.ai\/de-ch#warteliste"/);
  const sneaky = new URLSearchParams({ ...entry, email: "", page: "https://evil.example" });
  const bad = await waitlist.handleWaitlist(
    new Request("https://app.belline.ai/api/leads/waitlist", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: sneaky }),
    route(),
  );
  assert.equal(bad.status, 422);
  const text = await bad.text();
  assert.match(text, /E-Mail-Adresse/);
  assert.doesNotMatch(text, /evil\.example/, "the page links back to a URL the request chose");
});

test("the route runs this handler, the German pages post to it, and nothing on the way sends an email", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const routeSrc = fs.readFileSync(path.join(root, "src", "app", "api", "leads", "waitlist", "route.ts"), "utf8");
  assert.match(routeSrc, /handleWaitlist\(request, deps\)/);
  const lib = fs.readFileSync(path.join(root, "src", "lib", "leads", "waitlist.ts"), "utf8");
  assert.doesNotMatch(lib, /sendEmail|sendMail|resend|postmark|nodemailer|twilio/i, "the waitlist sends something");
  const page = fs.readFileSync(path.join(root, "public", "landing.de.html"), "utf8");
  assert.match(page, /<form class="book-form waitlist" id="warteliste" action="https:\/\/app\.belline\.ai\/api\/leads\/waitlist" method="post"/);
  for (const field of ["name", "email", "company", "country", "businessType", "website2", "page"]) assert.match(page, new RegExp(`name="${field}"`), field);
  // Enquiries became a source on the staff console's Leads list (2026-09-17): the waitlist is its own tag there.
  const leadList = fs.readFileSync(path.join(root, "src", "lib", "staff", "leads.ts"), "utf8");
  assert.match(leadList, /if \(isWaitlistLead\(lead\)\) return "waitlist_dach";/, "staff cannot tell a waitlist entry on the Leads list");
});

queue.then(() => {
  fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
  console.log(
    failed === 0
      ? `\n[32m✓ ${passed} passed, 0 failed[0m\n`
      : `\n[31m✗ ${passed} passed, ${failed} failed[0m\n`,
  );
  if (failed > 0) process.exitCode = 1;
});
