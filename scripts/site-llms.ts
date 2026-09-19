/**
 * `/llms.txt`, and the structured data the sector pages were missing.
 *
 * Both answer the same question from two directions: an assistant that has
 * been asked "find me an AI receptionist for my clinic" needs to be able to
 * read what Belline is, what it costs, where it works and what it will not do
 * — without rendering a marketing page and guessing.
 *
 * Everything here is derived. The prices come from the catalogue
 * (`src/lib/billing/plans.ts`), the countries from `src/lib/markets.ts`, the
 * languages from `src/config/languages.ts`, and what is actually switched on
 * from `src/lib/flags.ts`. Nothing in this file restates a number, because the
 * failure mode of a machine-readable summary is not being wrong today — it is
 * being right today and left behind on the morning a price changes.
 * `scripts/check-llms.ts` fails the build if any of it drifts.
 *
 * The format follows the llms.txt convention: an H1 with the name, a
 * blockquote summary, a little prose, then H2 sections of links, each
 * `- [Name](url): one line`. It is Markdown on purpose — it is meant to be
 * read by something that reads Markdown.
 */

import {
  CHANNELS,
  CHANNEL_ORDER,
  PACKS,
  TRIAL,
  VIDEO_VOICE_MINUTE_RATIO,
  annualMonthsSaved,
  poolText,
  priceOf,
  productById,
  publicLines,
  sellable,
  videoMinutesFor,
  type Market,
  type Product,
} from "../src/lib/billing/plans";
import { MARKETS, formatMoney, liveMarkets } from "../src/lib/markets";
import { LANGUAGE_REGISTRY } from "../src/config/languages";
import { languageUsable } from "../src/lib/language";
import { publicFlag } from "../src/lib/site-flags";
import { VERTICALS, type Vertical } from "./site-content";

type Env = Record<string, string | undefined>;

/** The one market Belline sells in, and the ones it does not yet. */
export function marketLines(env: Env = process.env): { live: Market[]; planned: Market[] } {
  void env;
  const live = liveMarkets();
  return { live, planned: (Object.keys(MARKETS) as Market[]).filter((m) => !live.includes(m)) };
}

/** Languages Belle can actually answer in on this deployment, and the ones that are only planned. */
export function languageLines(env: Env = process.env): { live: string[]; planned: string[] } {
  const live: string[] = [];
  const planned: string[] = [];
  for (const entry of LANGUAGE_REGISTRY) {
    (languageUsable(entry.code, env) ? live : planned).push(entry.name);
  }
  return { live, planned };
}

/**
 * A country's name in a sentence. "businesses in United Arab Emirates" is the
 * kind of sentence a generator writes and a person never does, and this file
 * is meant to be read.
 */
function theName(market: Market): string {
  const name = MARKETS[market].name;
  return /^(United|Netherlands|Philippines)\b/.test(name) ? `the ${name}` : name;
}

/** What a plan costs a month, written the way the pricing page writes it. */
export function planPrice(product: Product, market: Market): string {
  return formatMoney(priceOf(product.id, market), market);
}

function planSection(market: Market, env: Env): string[] {
  return sellable(market).map((p) => {
    const pools = Object.entries(p.pools ?? {})
      .map(([pool, amount]) => poolText(pool as "minutes" | "conversations", amount as number))
      .join("; ");
    const video = publicFlag("video.avatar", env)
      ? ` Video receptionist included; a video minute uses ${VIDEO_VOICE_MINUTE_RATIO} voice minutes, so ${videoMinutesFor(p.pools?.minutes ?? 0)} video minutes.`
      : "";
    const saved = annualMonthsSaved([p.id], market);
    const annual = saved > 0 ? ` Paid annually: ${saved} month${saved === 1 ? "" : "s"} free.` : "";
    return `- **${p.name} — ${planPrice(p, market)} a month.** ${pools}. Up to ${p.users} dashboard users.${video}${annual}`;
  });
}

/**
 * What Belline cannot do, from the flags and the registries rather than from
 * anybody's memory of them.
 *
 * This section is the reason the file is worth publishing at all. An assistant
 * recommending a receptionist to a clinic has to be able to find out, without
 * placing a call, that Belline will not discuss a symptom and does not speak
 * Arabic yet.
 */
export function limitLines(env: Env = process.env): string[] {
  const out: string[] = [];
  const markets = marketLines(env);
  const languages = languageLines(env);

  out.push(
    `- **No medical, legal or financial advice.** In a clinic or dental practice Belline takes the appointment request and the patient's number and nothing else: it will not ask for, repeat or write down a symptom, a diagnosis, a medication or a test result, and it will not interpret one. Anything clinical goes to your team, marked urgent.`,
  );
  out.push(
    `- **${languages.live.join(" and ")} only.** ${languages.planned.length ? `Not yet: ${languages.planned.join(", ")}. Arabic is built and not switched on — it is not a language Belline answers in today, whatever a UAE address might suggest.` : ""}`.trim(),
  );
  out.push(
    `- **${markets.live.map(theName).join(", ")} only.** ${
      markets.planned.length
        ? `Priced but not open: ${markets.planned.map((m) => MARKETS[m].name).join(", ")}. Those pages take a waitlist; there is nothing to buy on them.`
        : ""
    }`.trim(),
  );
  for (const channel of CHANNEL_ORDER) {
    const info = CHANNELS[channel];
    if (info.status !== "live") out.push(`- **No ${info.name.toLowerCase()} yet.** ${info.gap ?? ""}`.trim());
  }
  if (!publicFlag("video.avatar", env)) {
    out.push("- **No video receptionist.** It exists and is not switched on, so no venue can offer one today.");
  }
  if (!publicFlag("booking.google", env) && !publicFlag("booking.outlook", env) && !publicFlag("booking.calendly", env)) {
    out.push(
      "- **No calendar writes yet.** Belline takes the request — who, when, what — and your team books it in the system you already use. Google Calendar, Outlook and Calendly are built and waiting on each provider's review.",
    );
  }
  out.push(
    "- **It does not pretend to be a person.** Asked whether it is an AI, it says that it is. It answers only from what the business wrote, and takes a message when the answer is not there.",
  );
  out.push("- **It does not record call audio**, with one exception the caller chooses: a voicemail left before a business goes live.");
  return out;
}

/** The sector pages, one line each, from the same source that renders them. */
function sectorLines(origin: string, verticals: Vertical[] = VERTICALS): string[] {
  return verticals.map((v) => `- [Belline for ${v.name.toLowerCase()}](${origin}/${v.slug}): ${v.description}`);
}

export interface LlmsOptions {
  origin: string;
  market?: Market;
  env?: Env;
  /** Whether this build published the German waitlist pages. */
  german?: boolean;
}

export function renderLlmsTxt(opts: LlmsOptions): string {
  const env = opts.env ?? process.env;
  const market = opts.market ?? liveMarkets()[0] ?? "AE";
  const origin = opts.origin.replace(/\/+$/, "");
  const markets = marketLines(env);
  const languages = languageLines(env);
  const cheapest = sellable(market).reduce((a, b) => (priceOf(a.id, market) <= priceOf(b.id, market) ? a : b));
  const minutes = PACKS.find((p) => p.pool === "minutes");
  const conversations = PACKS.find((p) => p.pool === "conversations");

  const lines: string[] = [];
  lines.push("# Belline");
  lines.push("");
  lines.push(
    `> An AI receptionist for small businesses in ${markets.live.map(theName).join(" and ")}. It answers the website chat, the website's voice button, WhatsApp and the forwarded telephone from the business's own information, takes booking and callback requests, and passes anything it should not answer to a person. From ${formatMoney(
      priceOf(cheapest.id, market),
      market,
    )} a month, with ${TRIAL.days} days free and no card.`,
  );
  lines.push("");
  lines.push(
    "Belline is a product, not an agency. A business signs up, describes itself in its own words, forwards its number or drops a script tag on its website, and Belline answers from that description. Every conversation leaves a summary and a full transcript in the owner's dashboard. Belline never claims to be human, and it answers only from what the business wrote down — when it does not know, it takes a message.",
  );
  lines.push("");

  lines.push("## What it costs");
  lines.push("");
  lines.push(
    `Prices are per business per month, in ${MARKETS[market].currency}, and are generated from the product catalogue rather than written here by hand.`,
  );
  lines.push("");
  for (const line of planSection(market, env)) lines.push(line);
  lines.push("");
  lines.push(
    `- **Free trial:** ${TRIAL.days} days, no card. ${TRIAL.minutes} voice minutes and ${TRIAL.conversations} text conversations.`,
  );
  if (minutes && conversations) {
    lines.push(
      `- **If an allowance runs out**, the business chooses in advance what happens: add a top-up pack (${minutes.units} voice minutes for ${formatMoney(
        minutes.prices[market] ?? 0,
        market,
      )}, or ${conversations.units} text conversations for ${formatMoney(
        conversations.prices[market] ?? 0,
        market,
      )}) up to a monthly cap it sets, move up a plan, or simply stop. Nothing is charged that was not chosen.`,
    );
  }
  lines.push("- **No contract.** Monthly plans cancel at any time and run to the end of the paid period.");
  lines.push("");

  lines.push("## Where it works today");
  lines.push("");
  lines.push(
    `- **Live:** ${markets.live.map((m) => `${theName(m)} (${MARKETS[m].currency})`).join(", ")}. This is the only place Belline can be bought.`,
  );
  if (markets.planned.length) {
    lines.push(
      `- **Not open:** ${markets.planned
        .map((m) => MARKETS[m].name)
        .join(", ")}. Some of these have prices and a waitlist page; none of them has a checkout.`,
    );
  }
  lines.push(`- **Languages:** ${languages.live.join(", ")}.${languages.planned.length ? ` Not yet: ${languages.planned.join(", ")}.` : ""}`);
  lines.push("");

  lines.push("## What it cannot do");
  lines.push("");
  lines.push("Listed because an assistant recommending Belline to somebody should be able to rule it out as easily as rule it in.");
  lines.push("");
  for (const line of limitLines(env)) lines.push(line);
  lines.push("");

  lines.push("## Pages");
  lines.push("");
  lines.push(`- [Belline](${origin}/): what it does, how it works, the prices above, and a button that calls the receptionist so you can hear it.`);
  for (const line of sectorLines(origin)) lines.push(line);
  lines.push(`- [Privacy](${origin}/privacy): what is stored, for how long, and who can reach it.`);
  lines.push(`- [Terms](${origin}/terms): the agreement a business signs up under.`);
  if (opts.german) {
    lines.push(
      `- [German-language waitlist pages](${origin}/de-de): ${markets.planned
        .filter((m) => ["DE", "AT", "CH"].includes(m))
        .map((m) => MARKETS[m].name)
        .join(", ")} — planned prices and a waitlist, not a checkout.`,
    );
  }
  lines.push("");

  lines.push("## Contact");
  lines.push("");
  lines.push("- Email: hello@belline.ai");
  lines.push(`- Sign up: ${origin}/#price`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Structured data for the sector pages
// ---------------------------------------------------------------------------

/**
 * The JSON-LD each sector page had none of.
 *
 * A `Service` that says who provides it, where, and what it costs, plus the
 * breadcrumb that says where the page sits. The prices are the catalogue's, as
 * an `AggregateOffer`, so a clinic page cannot quote last quarter's Starter.
 */
export function verticalJsonLd(v: Vertical, origin: string, market: Market = liveMarkets()[0] ?? "AE"): string {
  const plans = sellable(market);
  const prices = plans.map((p) => priceOf(p.id, market) / 100);
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Service",
        "@id": `${origin}/${v.slug}#service`,
        name: `Belline for ${v.name.toLowerCase()}`,
        serviceType: "AI receptionist",
        description: v.description,
        url: `${origin}/${v.slug}`,
        provider: { "@id": `${origin}/#organization` },
        areaServed: liveMarkets().map((m) => ({ "@type": "Country", name: MARKETS[m].name })),
        availableChannel: {
          "@type": "ServiceChannel",
          serviceUrl: `${origin}/#price`,
          availableLanguage: languageLines().live,
        },
        offers: {
          "@type": "AggregateOffer",
          priceCurrency: MARKETS[market].currency,
          lowPrice: String(Math.min(...prices)),
          highPrice: String(Math.max(...prices)),
          offerCount: String(plans.length),
          availability: "https://schema.org/InStock",
          url: `${origin}/#price`,
        },
      },
      {
        "@type": "Organization",
        "@id": `${origin}/#organization`,
        name: "Belline",
        url: `${origin}/`,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Belline", item: `${origin}/` },
          { "@type": "ListItem", position: 2, name: v.name, item: `${origin}/${v.slug}` },
        ],
      },
    ],
  };
  return `<script type="application/ld+json">\n${JSON.stringify(graph, null, 2)}\n</script>`;
}

/** Tests and the build both want to know a plan is still where it was. */
export function catalogueFacts(market: Market = liveMarkets()[0] ?? "AE") {
  return sellable(market).map((p) => ({ id: p.id, name: p.name, price: planPrice(p, market), lines: publicLines(productById(p.id)) }));
}
