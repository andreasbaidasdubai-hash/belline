import net from "node:net";
import dns from "node:dns/promises";
import Anthropic from "@anthropic-ai/sdk";
import type { Location, Vertical, WeeklyHours } from "./types";
import { upsertLocation, listLocations } from "./store";
import { BELLINE_TENANT_ID } from "./tenancy";

/**
 * Personalised demos.
 *
 * A salesperson pastes a prospect's website. Two minutes later they can say
 * "call your own clinic" and the prospect hears Belline answer with their
 * name, their services and their hours. That is a different conversation from
 * twenty slides, and it is the reason this exists.
 *
 * Two things it is emphatically not:
 *
 *   Verified. Everything here is read off a public web page by a model. It is
 *   a plausible impression of the business, not its configuration, and every
 *   surface that shows it says so. Nothing from here is ever promoted to a
 *   real venue without a human rebuilding it.
 *
 *   Permanent. These expire. A demo that outlives the sales conversation is a
 *   page on the internet impersonating somebody's business.
 */

const DEMO_TTL_DAYS = 14;

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Refuse anything that resolves inside our own network.
 *
 * This endpoint takes a URL from a user and fetches it server-side, which is
 * the textbook shape of an SSRF: `http://169.254.169.254/` reads cloud
 * credentials, `http://localhost:3000` reads our own API. Checking the
 * hostname string is not enough — a name under someone else's control can
 * resolve to a private address — so the resolved addresses are what get
 * checked.
 */
function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a >= 224
    );
  }
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80") ||
    lower.startsWith("::ffff:")
  );
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error("That does not look like a web address.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http and https addresses can be read.");
  }

  const resolved = await dns.lookup(url.hostname, { all: true }).catch(() => {
    throw new Error(`Could not find ${url.hostname}.`);
  });

  if (resolved.length === 0 || resolved.some((r) => isPrivateAddress(r.address))) {
    throw new Error("That address is not reachable from the public internet.");
  }
  return url;
}

/** Page text, roughly. Enough for a model to read a business off. */
export async function readSite(raw: string): Promise<{ url: URL; text: string }> {
  const url = await assertPublicUrl(raw);

  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      // Identify honestly. Plenty of sites refuse an unknown reader, and the
      // answer to that is to say so and let the salesperson paste a different
      // page — not to dress up as a browser to get past it.
      "User-Agent": "BellineDemoBot/1.0 (+https://belline.ai)",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 403 || response.status === 429) {
    throw new Error(
      "That site blocks automated readers. Try a deeper page — their services or contact page often is not protected.",
    );
  }
  if (response.status === 404) {
    throw new Error("That page does not exist. Check the address.");
  }
  if (!response.ok) throw new Error(`That site returned ${response.status}.`);

  const html = (await response.text()).slice(0, 400_000);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length < 120) throw new Error("There was not enough readable text on that page.");
  return { url, text: text.slice(0, 24_000) };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface Extracted {
  name: string;
  vertical: Vertical;
  address: string;
  timezone: string;
  greeting: string;
  services: { name: string; durationMin: number; price: number }[];
  staff: string[];
  faqs: { q: string; a: string }[];
}

const SCHEMA = {
  type: "object" as const,
  properties: {
    name: { type: "string", description: "The trading name, as a receptionist would say it aloud." },
    vertical: { type: "string", enum: ["restaurant", "salon", "clinic"] },
    address: { type: "string", description: "One line. Empty string if the page does not say." },
    timezone: { type: "string", description: "IANA zone inferred from the address, e.g. Europe/London." },
    greeting: {
      type: "string",
      description:
        "What someone at this business's front desk says on picking up the phone. Name the business, " +
        "then offer help — 'Good afternoon, the Fat Duck, how can I help?'. Never the website's " +
        "marketing voice: nobody answering a telephone says 'where culinary imagination awaits you'.",
    },
    services: {
      type: "array",
      description: "Up to eight real services or menu sections found on the page.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          durationMin: { type: "number", description: "Realistic length in minutes." },
          price: { type: "number", description: "0 if the page does not state one." },
        },
        required: ["name", "durationMin", "price"],
      },
    },
    staff: { type: "array", description: "Named people found on the page.", items: { type: "string" } },
    faqs: {
      type: "array",
      description: "Up to six questions the page genuinely answers, with the page's own answer.",
      items: {
        type: "object",
        properties: { q: { type: "string" }, a: { type: "string" } },
        required: ["q", "a"],
      },
    },
  },
  required: ["name", "vertical", "address", "timezone", "greeting", "services", "staff", "faqs"],
};

export async function extractBusiness(text: string, url: URL): Promise<Extracted> {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 2000,
    output_config: { effort: "low" },
    tools: [
      {
        name: "describe_business",
        description: "Record what this business is, from its own website.",
        input_schema: SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: "describe_business" },
    messages: [
      {
        role: "user",
        content:
          `This is the readable text of ${url.href}. Read the business off it and call the tool.\n\n` +
          `Take only what the page actually says. Where it is silent, leave the field empty or zero — ` +
          `an invented price or a stylist who does not work there is worse than a gap, because this ` +
          `is played back to the owner of the business.\n\n` +
          text,
      },
    ],
  });

  const block = message.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Could not read a business off that page.");
  return block.input as Extracted;
}

// ---------------------------------------------------------------------------
// Building the demo
// ---------------------------------------------------------------------------

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "demo"
  );
}

/**
 * A working week, so the demo diary has something to offer.
 *
 * `WeeklyHours` is keyed by `Date.getDay()` — 0 is Sunday — and holds ranges,
 * not an open/close pair. Getting this shape wrong does not fail loudly: the
 * availability search simply finds nothing, and the demo tells the prospect
 * their own business is fully booked forever.
 */
function weekdayHours(open: number, close: number): WeeklyHours {
  const week: WeeklyHours = {};
  for (let day = 0; day <= 6; day++) {
    week[day] = day === 0 ? [] : [{ start: open, end: close }];
  }
  return week;
}

export function buildProspectLocation(found: Extracted, sourceUrl: string, slug: string): Location {
  const isRestaurant = found.vertical === "restaurant";

  const services = (found.services.length ? found.services : [{ name: "Consultation", durationMin: 30, price: 0 }])
    .slice(0, 8)
    .map((s, i) => ({
      id: `svc${i + 1}`,
      name: s.name,
      durationMin: Math.min(240, Math.max(15, Math.round(s.durationMin || 30))),
      bufferMin: 10,
      price: Math.max(0, Math.round(s.price || 0)),
    }));

  const staff = (found.staff.length ? found.staff : ["Alex", "Sam"]).slice(0, 6).map((name, i) => ({
    id: `stf${i + 1}`,
    name,
    serviceIds: services.map((s) => s.id),
    hours: weekdayHours(9 * 60, 18 * 60),
    timeOff: [],
  }));

  return {
    id: `prospect_${slug}`,
    // Ours. A demo built by reading somebody's website is sales material: it
    // impersonates a business that has signed up for nothing, and it must
    // never appear inside a paying customer's tenant.
    tenantId: BELLINE_TENANT_ID,
    businessId: `biz_prospect_${slug}`,
    name: found.name,
    address: found.address,
    phone: "",
    timezone: found.timezone || "Europe/London",
    vertical: found.vertical,
    // Guessed from the timezone rather than read off the page: a currency is
    // only ever spoken aloud beside a price the site actually stated.
    currency: found.timezone?.startsWith("America/")
      ? "USD"
      : found.timezone?.startsWith("Asia/Dubai")
        ? "AED"
        : found.timezone?.startsWith("Europe/London")
          ? "GBP"
          : "EUR",
    closures: [],
    hours: weekdayHours(isRestaurant ? 12 * 60 : 9 * 60, isRestaurant ? 23 * 60 : 18 * 60),
    agent: {
      displayName: "Belline",
      greeting: found.greeting,
      voiceId: process.env.ELEVENLABS_VOICE_ID || "hpp4J3VqNfWAUOO0d1Us",
      model: "claude-haiku-4-5",
      persona:
        "Warm, efficient and unhurried. You are standing at this business's own desk, so speak the way they would.",
      policies: [
        "This is a demonstration built from the business's public website. Nothing booked here is real.",
        "Never invent a price, a person or a policy that was not on their website.",
      ],
      faqs: found.faqs.slice(0, 6),
      maxCallSeconds: 300,
      bookingHorizonDays: 60,
    },
    restaurant: isRestaurant
      ? {
          tables: Array.from({ length: 10 }, (_, i) => ({
            id: `t${i + 1}`,
            name: String(i + 1),
            minSeats: i < 4 ? 1 : i < 8 ? 2 : 4,
            maxSeats: i < 4 ? 2 : i < 8 ? 4 : 8,
            section: i < 6 ? "Main" : "Terrace",
          })),
          services: [
            {
              id: "dinner",
              name: "Dinner",
              days: [0, 1, 2, 3, 4, 5, 6],
              start: 18 * 60,
              end: 22 * 60,
              lastSeating: 21 * 60 + 30,
              // Ordinary turn times. A demo with none holds every table for
              // zero minutes, which makes the diary look infinitely free —
              // the opposite of what this is meant to demonstrate.
              turnTimes: [
                { upTo: 2, minutes: 90 },
                { upTo: 4, minutes: 105 },
                { upTo: 8, minutes: 120 },
              ],
            },
          ],
          maxCoversPerSlot: 12,
          slotMinutes: 15,
          maxPartySize: 8,
          largePartyPolicy: "Parties above eight are taken as a message for the team to call back.",
        }
      : undefined,
    salon: isRestaurant
      ? undefined
      : { services, staff, resources: [], slotMinutes: 15 },
    demo: {
      enabled: true,
      maxCallsPerDay: 20,
      maxCallSeconds: 300,
      clearBookingsDaily: true,
      disclosure: `This is a Belline demonstration built from ${found.name}'s public website. Nothing you book here is real.`,
    },
    prospect: {
      slug,
      sourceUrl,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + DEMO_TTL_DAYS * 86_400_000).toISOString(),
    },
  };
}

export async function createProspectDemo(rawUrl: string): Promise<Location> {
  const { url, text } = await readSite(rawUrl);
  const found = await extractBusiness(text, url);
  const location = buildProspectLocation(found, url.href, slugify(found.name));
  upsertLocation(location);
  return location;
}

/** Every prospect demo that has not expired. */
export function listProspects(): Location[] {
  const now = Date.now();
  return listLocations().filter(
    (l) => l.prospect && new Date(l.prospect.expiresAt).getTime() > now,
  );
}

export function findProspect(slug: string): Location | undefined {
  return listProspects().find((l) => l.prospect?.slug === slug);
}
