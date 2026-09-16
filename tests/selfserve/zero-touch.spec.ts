import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Browser, Page, TestInfo } from "@playwright/test";
import { blockExternal, expect, test } from "./helpers";

/**
 * Zero-touch: one owner, from the signup form to live, with nobody at Belline
 * lifting a finger (plan section 5).
 *
 * Runs only under `playwright.zero-touch.config.ts`: stubs on, a database that
 * cannot exist, a fresh data directory, and the number pool, card payments and
 * email switched on against their fakes. Provider hosts are blocked in the
 * browser, and the server's own fetch guard throws on anything not local.
 *
 * Personas:
 *   salon-requests  the full journey at both widths, through Go live, billing
 *                   and a password reset.
 *   clinic          the same steps up to the checks, then the gate stays shut.
 *
 * A step the product cannot do locally yet is a `test.fixme` below, with the
 * reason, rather than an assertion that pretends.
 *
 * Screenshots per step go to ZT_SHOTS_DIR (default: a folder in the system
 * temp directory), with timings.json beside them.
 *
 *   npx playwright test --config playwright.zero-touch.config.ts
 */

const DATA_DIR = process.env.ZT_DATA_DIR ?? "";
const SHOTS = process.env.ZT_SHOTS_DIR ?? path.join(os.tmpdir(), "belline-e2e-shots");
const PASSWORD = "Correct-Horse-Battery-9";
const TRANSFER = "+971 4 555 0100";
const MAX_UI_MS = 8 * 60_000;

test.describe.configure({ mode: "serial" });

// ── Reading what the server saved ────────────────────────────────────────────

function readJson<T>(name: string): T[] {
  const file = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")) as T[];
}

interface SavedVenue {
  id: string;
  tenantId: string;
  name: string;
  currency: string;
  phone?: string;
  embed?: { key?: string };
  subscription?: { status?: string; startedOn?: string };
  onboarding?: { activatedAt?: string; terms?: unknown };
}

function venueNamed(name: string): SavedVenue {
  const venue = readJson<SavedVenue>("locations").find((l) => l.name === name);
  expect(venue, `no saved venue called ${name}`).toBeTruthy();
  return venue!;
}

// ── Evidence: screenshots, timings, and no mailto:hello@ anywhere ───────────

class Journey {
  private n = 0;
  private started = Date.now();
  readonly timings: { step: string; ms: number }[] = [];

  constructor(
    private readonly page: Page,
    private readonly persona: string,
    private readonly info: TestInfo,
  ) {}

  /** Run one step, then photograph it and check the page offers no email escape hatch. */
  async step(name: string, body: () => Promise<void>) {
    const t0 = Date.now();
    await test.step(name, body);
    this.timings.push({ step: name, ms: Date.now() - t0 });
    this.n += 1;
    const dir = path.join(SHOTS, this.info.project.name);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${this.persona}-${String(this.n).padStart(2, "0")}-${name.replace(/\W+/g, "-").toLowerCase()}.png`;
    await this.page.screenshot({ path: path.join(dir, file), fullPage: true });
    await expect(this.page.locator('a[href^="mailto:hello@"]'), `mailto:hello@ on ${this.page.url()}`).toHaveCount(0);
  }

  write() {
    const total = Date.now() - this.started;
    const dir = path.join(SHOTS, this.info.project.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${this.persona}-timings.json`), JSON.stringify({ totalMs: total, steps: this.timings }, null, 2));
    expect(total, "the stubbed journey took longer than eight minutes").toBeLessThan(MAX_UI_MS);
  }
}

// ── A local website for the widget ───────────────────────────────────────────

async function fixtureSite(): Promise<{ origin: string; setSnippet: (s: string) => void; close: () => void }> {
  let snippet = "";
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body><h1>Fixture business</h1>${snippet}</body></html>`);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${port}`, setSnippet: (s) => (snippet = s), close: () => server.close() });
    });
  });
}

/** A visitor who has never signed in to Belline, on its own blocked-provider context. */
async function anonymousVisit(browser: Browser, url: string) {
  const context = await browser.newContext();
  await blockExternal(context);
  const page = await context.newPage();
  await page.goto(url);
  return { page, close: () => context.close() };
}

// ── Steps shared by both personas ────────────────────────────────────────────

async function signUp(page: Page, j: Journey, opts: { name: string; email: string; trade: string }) {
  await j.step("signup", async () => {
    await page.goto(`/checkout?trade=${opts.trade}`);
    // The landing page's trade only prefills; nothing offers an email address instead.
    // #trade, not #vertical: the field was renamed when the list widened from
    // three trades to seventeen, and the trade key is deliberately not an
    // engine vertical — check-backend asserts a trade like "garage" is refused
    // as one. The rename and this spec landed on separate branches and merged
    // cleanly without anyone reconciling them, which is why this journey had
    // never once run past its first assertion.
    await expect(page.locator("#trade")).toHaveValue(opts.trade);
    await expect(page.getByText(/Email us/i)).toHaveCount(0);

    await page.getByLabel("Business name").fill(opts.name);
    await page.getByLabel("Your email").fill(opts.email);
    await page.getByLabel("Choose a password").fill("belline rocks");
    await page.locator("#acceptTerms").check();
    await page.getByRole("button", { name: "Start free trial" }).click();
    // The same rule the server applies, said before a round trip. (Next's route announcer is also an alert.)
    await expect(page.getByRole("alert").filter({ hasText: /common word|characters/ })).toBeVisible();
    await expect(page).toHaveURL(/\/checkout/);

    await page.getByLabel("Choose a password").fill(PASSWORD);
    await page.getByRole("button", { name: "Start free trial" }).click();
    await page.waitForURL("**/setup/import", { timeout: 60_000 });

    // One tenant for this owner, prices in dirhams whatever the browser's timezone, terms recorded.
    const venue = venueNamed(opts.name);
    expect(readJson<{ id: string }>("tenants").filter((t) => t.id === venue.tenantId)).toHaveLength(1);
    expect(venue.currency).toBe("AED");
    const tenant = readJson<{ id: string; onboarding?: { terms?: { tosVersion?: string } } }>("tenants").find((t) => t.id === venue.tenantId);
    expect(tenant?.onboarding?.terms?.tosVersion).toBeTruthy();
  });
}

async function reviewByHand(page: Page, j: Journey, opts: { name: string; service: string }) {
  await j.step("review", async () => {
    await page.getByRole("button", { name: "Set it up by hand" }).first().click();
    await expect(page).toHaveURL(/\/setup\/review$/);
    await page.getByLabel("Address").fill("Shop 4, Jumeirah Beach Road, Dubai");
    await page.getByRole("button", { name: "Add a service" }).click();
    await page.getByLabel("Service 1 name").fill(opts.service);
    await page.getByLabel("Service 1 minutes").fill("60");
    await page.getByLabel("Service 1 price").fill("150");
    await page.locator("#review-staff").fill("Layla");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("button", { name: "Add a question" }).click();
    await page.getByLabel("Question 1").fill("Is there parking?");
    await page.getByLabel("Answer 1").fill("Yes, free parking behind the building.");
    await page.getByRole("button", { name: "That's right — save it" }).click();
    await page.waitForURL("**/setup/bookings");

    // What was typed is what was saved, after a reload.
    await page.goto("/setup/review");
    await expect(page.getByLabel("Address")).toHaveValue("Shop 4, Jumeirah Beach Road, Dubai");
    await expect(page.getByLabel("Service 1 price")).toHaveValue("150");
    await expect(page.getByLabel("Answer 1")).toHaveValue("Yes, free parking behind the building.");
    await page.goto("/setup/bookings");
  });
}

async function rules(page: Page, j: Journey) {
  await j.step("rules", async () => {
    await page.waitForURL("**/setup/rules");
    const form = page.locator("form");
    // Six questions at most. Since 2026-09-16 each phone number has a country picker beside it,
    // which is part of that number's question, not another one: the pickers are not counted.
    expect(await form.locator('input:visible, select:visible:not([aria-label="Country code"]), textarea:visible').count()).toBeLessThanOrEqual(6);
    await expect(form.getByLabel("Country code")).toHaveCount(2);
    const confirm = page.getByRole("button", { name: "Confirm these rules" });
    await expect(confirm).toBeInViewport();

    await page.getByLabel("Number for urgent calls").fill("+44 20 7946 0958");
    await confirm.click();
    await expect(page.getByRole("alert").filter({ hasText: "outside United Arab Emirates" })).toBeVisible();

    await page.getByLabel("Number for urgent calls").fill(TRANSFER);
    await confirm.click();
    await page.waitForURL("**/setup/channels");
  });
}

/** Switch the widget on for the fixture site and wait for the page to see it load. */
async function website(page: Page, j: Journey, browser: Browser, site: Awaited<ReturnType<typeof fixtureSite>>, baseURL: string) {
  await j.step("website widget", async () => {
    await page.goto("/website?from=setup");
    await page.getByLabel("Your website addresses").fill(site.origin);
    // A click that lands before the page is live does nothing, so press until it takes.
    const pre = page.locator("pre.widget-snippet");
    await expect(async () => {
      await page.getByRole("button", { name: "Switch it on" }).click();
      await expect(pre).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 45_000 });
    site.setSnippet((await pre.textContent())!.replace(/src="https?:\/\/[^/]+/, `src="${baseURL}`));

    // A stranger's visit before going live: the install counts, and the widget
    // takes itself off the page once the config says the venue is not live.
    // It is on the page until that answer arrives, which is a flash on a warm
    // server and longer on a cold one.
    const visitor = await anonymousVisit(browser, site.origin);
    await expect(visitor.page.locator(".belline-dock")).toHaveCount(0, { timeout: 60_000 });
    await visitor.close();

    // No click: the page notices on its next poll, which is every twenty seconds.
    await expect(page.getByText("Installed. The widget has loaded on your website.")).toBeVisible({ timeout: 45_000 });
  });
}

async function runChecks(page: Page, j: Journey) {
  await j.step("checks", async () => {
    await page.goto("/setup/test");
    await page.getByTestId("run-checks").click();
    await expect(page.locator('[data-check][data-passed="true"]')).toHaveCount(8, { timeout: 90_000 });
    await expect(page.getByText("Every check passed.")).toBeVisible();
  });
}

// ── Twilio's signature, as the webhook checks it ─────────────────────────────

function twilioSign(url: string, params: Record<string, string>, token: string): string {
  const payload = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", token).update(payload, "utf8").digest("base64");
}

// ═════════════════════════════════════════════════════════════════════════════

test("salon-requests: signup to live, then billing and a password reset, with no human", async ({ page, context, browser, baseURL }, info) => {
  const run = `${info.project.name.replace(/\W/g, "")}${Date.now()}`;
  const name = `Zero Touch Salon ${run}`;
  const email = `owner+zt${run}@example.com`;
  const j = new Journey(page, "salon-requests", info);
  const site = await fixtureSite();
  let chatLinkPath = "";

  try {
    await signUp(page, j, { name, email, trade: "salon" });
    await reviewByHand(page, j, { name, service: "Blow-dry" });

    await j.step("destination", async () => {
      await expect(page.getByRole("radio", { name: /Google Calendar/ })).toBeDisabled();
      await expect(page.getByRole("radio", { name: /Outlook/ })).toBeDisabled();
      await expect(page.getByText("Coming soon", { exact: true }).first()).toBeVisible();
      await page.getByRole("button", { name: "Request Fresha" }).click();
      await expect(page.getByText("We'll let you know when Fresha is ready.")).toBeVisible();
      await page.getByRole("radio", { name: /I have a booking link/ }).check();
      await page.getByLabel("Your booking link").fill("https://book.example-salon.test");
      await page.getByRole("button", { name: "Use this" }).click();
    });

    await rules(page, j);

    // Go live is not on the page, and a hand-made request is refused, before the checks.
    await j.step("gate before checks", async () => {
      await page.goto("/setup/golive");
      await expect(page.getByRole("button", { name: "Go live" })).toHaveCount(0);
      const res = await page.request.post("/api/setup/activate", { data: {} });
      expect(res.status()).toBe(409);
      expect(((await res.json()) as { blockers: unknown[] }).blockers.length).toBeGreaterThan(0);

      // Added 2026-09-16: setup never blocks the dashboard. Before going live the full
      // menu is there, with what is left of setup as a checklist on Today.
      await page.goto("/");
      await expect(page.locator("nav.nav")).toContainText("Requests");
      await expect(page.getByTestId("setup-checklist")).toContainText(/\d of 7 done/);
    });

    await j.step("phone number and forwarding test", async () => {
      await page.goto("/golive?from=setup");
      await page.getByRole("button", { name: "Get my number" }).click();
      // Two numbers in the stub pool, one per project: whichever this run got, it is real, not a placeholder.
      const number = page.locator("strong.mono");
      await expect(number).toHaveText(/^\+9714000000[12]$/, { timeout: 15_000 });
      const assigned = (await number.textContent())!.trim();
      await expect(page.locator("body")).not.toContainText("<your Belline number>");

      // "Get my number" reloads the page, so wait for the carrier switch to
      // actually take before pressing anything else: a click that lands before
      // the page is live does nothing at all.
      const eand = page.getByRole("button", { name: /e& \(Etisalat\) mobile/ });
      await expect(async () => {
        await eand.click();
        await expect(eand).toHaveAttribute("aria-pressed", "true", { timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      const tels = await page.locator('table.forward-table a[href^="tel:"]').evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
      // Three codes forward to the number; the fourth switches forwarding off (##004#).
      const tail = assigned.replace(/\D/g, "").slice(-8);
      expect(tels.filter((t) => t.replace(/\D/g, "").includes(tail)).length).toBe(3);
      expect(tels.every((t) => /^tel:[\d*#%+]+$/.test(t)), `a code is not dialable: ${tels.join(" ")}`).toBe(true);

      const opened = page.waitForResponse((r) => r.url().includes("/api/phone/verify") && r.request().method() === "POST");
      await page.getByRole("button", { name: "I've set it — test it" }).click();
      const openedRes = await opened;
      expect(openedRes.status(), await openedRes.text()).toBe(200);
      await expect(page.getByText("From any other phone, call your business number")).toBeVisible({ timeout: 30_000 });

      // Twilio's webhook for the forwarded test call, signed as Twilio signs it.
      // The webhook rebuilds the URL it verifies from the forwarded headers, which are http here.
      const url = `http://localhost:${new URL(baseURL!).port}/api/twilio/voice`;
      const params = { CallSid: `CAstub${run}`, To: assigned, From: "+971500000000", ForwardedFrom: TRANSFER.replace(/\s/g, "") };
      const res = await page.request.post(`${baseURL}/api/twilio/voice`, {
        form: params,
        headers: { "x-twilio-signature": twilioSign(url, params, "stub-token") },
      });
      expect(res.status()).toBe(200);
      const twiml = await res.text();
      expect(twiml).toContain("<Hangup/>");
      expect(twiml).not.toContain("<Stream");

      // The page asks every five seconds.
      await expect(page.getByText("Forwarding works. Your test call reached Belline.")).toBeVisible({ timeout: 30_000 });

      // The test call is recorded as a test, so no stat, report or bill sees it.
      const venue = venueNamed(name);
      const calls = readJson<{ locationId: string; isTest?: boolean }>("calls").filter((c) => c.locationId === venue.id);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter((c) => !c.isTest)).toHaveLength(0);
    });

    await website(page, j, browser, site, baseURL!);

    await j.step("channels", async () => {
      await page.goto("/setup/channels");
      // WhatsApp is optional and not switched on here; the journey does not wait for it.
      await expect(page.getByText("Going live does not wait for it.")).toBeVisible();

      // Added 2026-09-16: the chat link, a channel with no website. Before Go live a
      // stranger who opens it sees one neutral sentence and nothing about the venue.
      await page.getByTestId("create-chat-link").click();
      const linkUrl = await page.getByTestId("chat-link-url").inputValue();
      chatLinkPath = new URL(linkUrl).pathname;
      expect(chatLinkPath).toMatch(/^\/c\/bc_/);
      const stranger = await anonymousVisit(browser, `${baseURL}${chatLinkPath}`);
      await expect(stranger.page.getByTestId("chat-link-refused")).toHaveText("This chat isn't available yet. Please check back soon.");
      await expect(stranger.page.locator("body")).not.toContainText(name);
      await stranger.close();
      await page.getByRole("link", { name: "Continue" }).click();
      await page.waitForURL("**/setup/test");
    });

    await runChecks(page, j);

    await j.step("go live", async () => {
      await page.goto("/setup/golive");
      const goLive = page.getByRole("button", { name: "Go live" });
      await expect(goLive).toBeVisible();
      await goLive.click();
      await page.waitForURL((u) => !u.pathname.endsWith("/setup/golive"));
      expect(venueNamed(name).onboarding?.activatedAt).toBeTruthy();

      await page.goto("/");
      // The dashboard's own destinations, which the collapsed setup menu does not have
      // (nav.ts since ed55df0: "Needs you" is now "Today"; a request-only venue works
      // from "Requests", and the calendar sits under "Everything else").
      await expect(page.locator("nav.nav")).toContainText("Today");
      await expect(page.locator("nav.nav")).toContainText("Requests");

      // Now the widget is public: a stranger sees it.
      const visitor = await anonymousVisit(browser, site.origin);
      await expect(visitor.page.locator(".belline-dock")).toBeVisible({ timeout: 15_000 });
      await visitor.close();

      // And the chat link opens the chat, with no second Go live.
      const linkVisitor = await anonymousVisit(browser, `${baseURL}${chatLinkPath}`);
      await expect(linkVisitor.page.getByTestId("chat-link-refused")).toHaveCount(0);
      await expect(linkVisitor.page.locator("textarea")).toBeVisible();
      await linkVisitor.close();
    });

    await j.step("billing choice and plan", async () => {
      await page.goto("/billing");
      const panel = page.locator(".panel", { has: page.getByText("When an allowance runs out") });
      await panel.getByLabel(/Stop at the allowance/).check();
      await panel.getByRole("button", { name: "Save choice" }).click();
      await expect(panel.getByText("Saved.")).toBeVisible();

      // Card payments on, against the fake Stripe: the stub checkout delivers the webhook twice.
      await page.goto("/checkout");
      await page.getByRole("button", { name: "Choose plan" }).click();
      await page.waitForURL((u) => u.pathname !== "/checkout" && !u.pathname.startsWith("/__stub"), { timeout: 30_000 });
      const first = venueNamed(name).subscription;
      expect(first?.status).toBe("active");
      expect(first?.startedOn).toBeTruthy();
    });

    await j.step("password reset", async () => {
      await context.clearCookies();
      await page.goto("/login/forgot");
      await page.getByLabel("Email").fill(email);
      await page.getByRole("button", { name: "Send me a link" }).click();

      // The stub mailer writes to the outbox beside the data; nothing reaches an email provider.
      let link = "";
      await expect(async () => {
        const outbox = path.join(DATA_DIR, "outbox.ndjson");
        const lines = fs.existsSync(outbox) ? fs.readFileSync(outbox, "utf8").trim().split("\n") : [];
        const mine = lines.filter((l) => l.includes(email)).pop() ?? "";
        link = /\/login\/reset\?[^\s"\\]+/.exec(mine)?.[0] ?? "";
        expect(link).not.toBe("");
      }).toPass({ timeout: 20_000 });

      // The email carries the public address; this run only has this machine.
      await page.goto(link.startsWith("/") ? link : new URL(link).pathname + new URL(link).search);
      await page.getByLabel("New password").fill("Another-Horse-Battery-7");
      await page.getByLabel("The same again").fill("Another-Horse-Battery-7");
      await page.getByRole("button", { name: "Save and sign in" }).click();
      await page.waitForURL((u) => !u.pathname.startsWith("/login"));

      await context.clearCookies();
      await page.goto("/login");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill("Another-Horse-Battery-7");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL((u) => !u.pathname.startsWith("/login"));
    });

    await j.step("no human touch", async () => {
      const venue = venueNamed(name);
      const tickets = readJson<{ tenantId?: string; locationId?: string; kind: string }>("exceptions").filter(
        (e) => e.tenantId === venue.tenantId || e.locationId === venue.id,
      );
      expect(tickets, `exceptions opened for the salon: ${tickets.map((t) => t.kind).join(", ")}`).toHaveLength(0);
    });

    j.write();
  } finally {
    site.close();
  }
});

test("clinic: every step done, the checks pass, and Go live stays shut", async ({ page, browser, baseURL }, info) => {
  const run = `${info.project.name.replace(/\W/g, "")}${Date.now()}`;
  const name = `Zero Touch Clinic ${run}`;
  const j = new Journey(page, "clinic", info);
  const site = await fixtureSite();

  try {
    await signUp(page, j, { name, email: `owner+ztclinic${run}@example.com`, trade: "clinic" });
    await reviewByHand(page, j, { name, service: "Consultation" });

    await j.step("destination", async () => {
      // A clinic in preview takes requests only; calendars are not offered.
      await expect(page.getByRole("radio", { name: /Google Calendar/ })).toHaveCount(0);
      await page.getByRole("button", { name: "Use this" }).click();
    });

    await rules(page, j);

    // Both salons took the two stub numbers first, so on the second project the pool is empty.
    if (info.project.name === "desktop-1440") {
      await j.step("pool empty", async () => {
        await page.goto("/golive?from=setup");
        await page.getByRole("button", { name: "Get my number" }).click();
        await expect(page.getByText(/Your number is being prepared/)).toBeVisible();
        await expect(page.getByText(/Ticket B-/)).toBeVisible();
        const venue = venueNamed(name);
        expect(readJson<{ locationId?: string; kind: string }>("exceptions").some((e) => e.locationId === venue.id && e.kind === "pool_empty")).toBe(true);
      });
    }

    await website(page, j, browser, site, baseURL!);
    await runChecks(page, j);

    await j.step("gate stays shut", async () => {
      await page.goto("/setup/golive");
      await expect(page.getByRole("button", { name: "Go live" })).toHaveCount(0);
      await expect(page.locator("main")).toContainText("Clinics open soon");
      const res = await page.request.post("/api/setup/activate", { data: {} });
      expect(res.status()).toBe(409);
      expect(venueNamed(name).onboarding?.activatedAt).toBeFalsy();
    });

    j.write();
  } finally {
    site.close();
  }
});

// ── Plan section 5 steps with no local path yet ──────────────────────────────

test.fixme("landing: 'Connect your business' on the site opens /checkout?trade=salon", () => {
  // The marketing site is built separately (site/, other config); the app has no landing route to click from.
});
test.fixme("import: a website and price-list.pdf read by the stub model into a draft with one missing price", () => {
  // No stub site reader or scripted import model is wired under FLAG_STUBS; import falls back to setting up by hand.
});
test.fixme("rules: the urgent-call number is prefilled from the import", () => {
  // Depends on the stubbed import above; the hand-made path enters no business phone.
});
test.fixme("whatsapp: skip, and the self-serve branch to Live via /__stub/jobs/whatsapp-status", () => {
  // Finishing the connection needs Postgres, and the stub job route is not built.
});
test.fixme("checks: a scripted wrong FAQ answer fails, Fix with Belle calls edit_faq, the re-run passes", () => {
  // The stubbed server has no hook to script the receptionist or Belle per test.
});
test.fixme("first enquiry: an anonymous visitor asks for a blow-dry and the owner sees one request", () => {
  // Web chat needs Postgres (resolveVisitor answers 503 without DATABASE_URL).
});
test.fixme("lifecycle: outbox row first_enquiry with status suppressed_flag", () => {
  // Lifecycle messages are not built.
});
test.fixme("after launch: pause, resume, export ZIP and cancel with a reason", () => {
  // No pause, account export or cancel flow exists yet (P1).
});
test.fixme("exceptions: a seeded staff user sees pool_empty on /sales/exceptions", () => {
  // No staff login is seeded for stubbed runs; the clinic test checks the pool_empty row in the data instead.
});
test.fixme("funnel: events.ndjson holds signup.created through account.activated and enquiry.first", () => {
  // track() needs Postgres and has no file fallback.
});
