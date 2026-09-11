import { z } from "zod";
import { structured } from "../llm/call";
import { SIGNALS } from "../config/schema";
import type { CrawlResult } from "./crawl";

/**
 * The Company Research Agent.
 *
 * Reads a prospect's own website and produces the structured signals that
 * scoring and demo generation both depend on. It is the first stage where a
 * model's output reaches a person — the personalised email quotes it — so the
 * guarantees here are enforced in code rather than requested in a prompt.
 *
 * Three of them matter more than the rest:
 *
 *   **Unknown is not false.** A signal with no supporting evidence is stored
 *   as `null`. "We could not tell whether they have several branches" and
 *   "they do not have several branches" lead to very different emails, and
 *   only one of them is honest.
 *
 *   **Every claim cites a page we actually fetched.** Evidence naming a URL
 *   outside the crawl is discarded — a model citing a page it never saw is
 *   exactly how a confidently wrong first email gets written.
 *
 *   **Use cases are drawn from the service catalogue**, never invented, so an
 *   agent cannot promise a capability Belline does not have.
 */

const SignalSchema = z
  .object({
    multi_location: z.boolean().nullable(),
    location_count: z.number().int().min(1).max(500).nullable(),
    long_hours: z.boolean().nullable(),
    weekend_open: z.boolean().nullable(),
    appointment_based: z.boolean().nullable(),
    online_booking: z.boolean().nullable(),
    booking_provider: z.string().nullable(),
    whatsapp_booking: z.boolean().nullable(),
    phone_first: z.boolean().nullable(),
    has_front_desk: z.boolean().nullable(),
    practitioner_count: z.number().int().min(1).max(500).nullable(),
    languages_advertised: z.array(z.string()),
    premium_positioning: z.boolean().nullable(),
    recent_expansion: z.boolean().nullable(),
    after_hours_gap: z.boolean().nullable(),
    high_ticket: z.boolean().nullable(),
  })
  .strict();

const EvidenceSchema = z.object({
  claim: z.string().min(3),
  url: z.string(),
  quote: z.string(),
});

export const ResearchSchema = z.object({
  summary: z.string().min(40),
  signals: SignalSchema,
  use_cases: z.array(z.string()),
  evidence: z.array(EvidenceSchema),
  /** Anything the pages genuinely did not say. Useful and honest. */
  unknowns: z.array(z.string()),
});

export type Research = z.infer<typeof ResearchSchema>;

/** JSON Schema for the API. Mirrors the zod above; the zod is the enforcer. */
const INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    summary: {
      type: "string",
      description:
        "Three to five sentences answering: why is this company a good prospect for an AI phone receptionist? " +
        "Concrete and specific to them. No marketing language, no adjectives you cannot source from the page.",
    },
    signals: {
      type: "object",
      description:
        "Use null for anything the pages do not establish. null means 'could not tell' and is always " +
        "preferable to a guess — these values are scored and quoted back to the business owner.",
      properties: {
        multi_location: { type: ["boolean", "null"], description: "More than one branch." },
        location_count: { type: ["integer", "null"] },
        long_hours: { type: ["boolean", "null"], description: "Open beyond roughly 9-6." },
        weekend_open: { type: ["boolean", "null"] },
        appointment_based: { type: ["boolean", "null"], description: "Business runs on booked appointments." },
        online_booking: { type: ["boolean", "null"], description: "A real self-serve booking system, not a contact form." },
        booking_provider: { type: ["string", "null"], description: "Named system if visible, e.g. Zenoti, Fresha, Doctolib." },
        whatsapp_booking: { type: ["boolean", "null"] },
        phone_first: { type: ["boolean", "null"], description: "Phone is the primary way to book." },
        has_front_desk: { type: ["boolean", "null"], description: "Evidence of reception staff." },
        practitioner_count: { type: ["integer", "null"], description: "Named practitioners listed." },
        languages_advertised: { type: "array", items: { type: "string" }, description: "Only languages the site states." },
        premium_positioning: { type: ["boolean", "null"] },
        recent_expansion: { type: ["boolean", "null"], description: "A new branch or recent opening mentioned." },
        after_hours_gap: { type: ["boolean", "null"], description: "Closed at times customers would plausibly call." },
        high_ticket: { type: ["boolean", "null"], description: "High-value treatments: implants, orthodontics, surgery." },
      },
      required: [
        "multi_location", "location_count", "long_hours", "weekend_open", "appointment_based",
        "online_booking", "booking_provider", "whatsapp_booking", "phone_first", "has_front_desk",
        "practitioner_count", "languages_advertised", "premium_positioning", "recent_expansion",
        "after_hours_gap", "high_ticket",
      ],
      additionalProperties: false,
    },
    use_cases: {
      type: "array",
      items: { type: "string" },
      description: "Which of the listed Belline services fit this business. Slugs only, from the list given.",
    },
    evidence: {
      type: "array",
      description:
        "One entry per non-obvious signal. The url must be one of the pages provided — never any other address.",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          url: { type: "string" },
          quote: { type: "string", description: "A short verbatim phrase from that page." },
        },
        required: ["claim", "url", "quote"],
        additionalProperties: false,
      },
    },
    unknowns: {
      type: "array",
      items: { type: "string" },
      description: "What the pages did not say that would have mattered.",
    },
  },
  required: ["summary", "signals", "use_cases", "evidence", "unknowns"],
  additionalProperties: false,
};

const SYSTEM = `You research service businesses for Belline, an AI phone receptionist sold to clinics, salons and restaurants.

You read a company's own website and record what it says. You are building evidence a salesperson will quote back to the business owner, so an invented detail is worse than a gap — it destroys the conversation it was meant to start.

Rules:
- Record only what the pages state. Where they are silent, use null.
- null means "could not tell". false means "the page shows this is not so". They are different and both are useful.
- Every non-obvious signal needs an evidence entry citing one of the supplied page URLs and quoting the words that support it.
- Never cite a URL that was not supplied to you.
- Do not infer from the business's category what a specific business does. A dental clinic that does not mention implants may not offer them.
- Judge prospect quality by how much inbound phone traffic the business plausibly gets and how poorly it is currently covered outside working hours.`;

export interface ResearchInput {
  agentId: number;
  leadId: number;
  companyName: string;
  city: string | null;
  vertical: string | null;
  crawl: CrawlResult;
  /** Slugs the agent is allowed to sell. Anything else is dropped. */
  allowedServices: string[];
  /** Agent-specific steer from configuration. */
  researchPrompt: string;
  /** Facts already known from discovery, so the model does not re-derive them. */
  known: { rating?: number | null; reviewCount?: number | null; branches?: number };
}

export interface ResearchOutput {
  research: Research;
  model: string;
  costUsd: number;
  promptHash: string;
  /** Claims discarded because they cited a page we never fetched. */
  droppedEvidence: string[];
  droppedUseCases: string[];
}

export async function researchCompany(input: ResearchInput): Promise<ResearchOutput> {
  const { crawl } = input;

  const document = crawl.pages
    .map((p) => `--- ${p.role.toUpperCase()} · ${p.url}\n${p.text.slice(0, 12_000)}`)
    .join("\n\n");

  const prompt = [
    `Company: ${input.companyName}`,
    input.city ? `City: ${input.city}` : "",
    input.vertical ? `Category: ${input.vertical}` : "",
    input.known.rating ? `Google rating: ${input.known.rating} from ${input.known.reviewCount ?? "?"} reviews` : "",
    input.known.branches && input.known.branches > 1
      ? `Discovery found ${input.known.branches} separate locations for this business.`
      : "",
    "",
    `Belline services you may cite (use these slugs, no others): ${input.allowedServices.join(", ")}`,
    "",
    input.researchPrompt ? `Focus: ${input.researchPrompt}` : "",
    "",
    `Pages fetched (these are the ONLY URLs you may cite):`,
    ...crawl.fetched.map((u) => `  ${u}`),
    "",
    document,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await structured<Research>({
    task: "research",
    agentId: input.agentId,
    leadId: input.leadId,
    system: SYSTEM,
    prompt,
    toolName: "record_research",
    toolDescription: "Record what this company's website says, for a sales team.",
    inputSchema: INPUT_SCHEMA,
    schema: ResearchSchema,
    maxTokens: 3000,
  });

  return {
    ...postCheck(result.value, crawl.fetched, input.allowedServices),
    model: result.model,
    costUsd: result.costUsd,
    promptHash: result.promptHash,
  };
}

/**
 * The guarantees, enforced after the model has spoken.
 *
 * Everything here could in principle be a prompt instruction. None of it is,
 * because a prompt instruction is followed most of the time, and "most of the
 * time" is the worst way for this particular thing to fail — it produces a
 * confident, plausible, wrong claim about somebody's business.
 */
export function postCheck(
  research: Research,
  fetched: string[],
  allowedServices: string[],
): { research: Research; droppedEvidence: string[]; droppedUseCases: string[] } {
  const allowedUrls = new Set(fetched.map(canonical));

  const droppedEvidence: string[] = [];
  const evidence = research.evidence.filter((e) => {
    if (allowedUrls.has(canonical(e.url))) return true;
    droppedEvidence.push(`${e.claim} (cited ${e.url})`);
    return false;
  });

  const allowed = new Set(allowedServices);
  const droppedUseCases: string[] = [];
  const useCases = research.use_cases.filter((u) => {
    if (allowed.has(u)) return true;
    droppedUseCases.push(u);
    return false;
  });

  // A signal whose supporting evidence was just discarded is no longer
  // supported, so it reverts to unknown. This is the check that turns "cited a
  // page it never read" from a logged curiosity into an actual correction.
  const supported = new Set(evidence.map((e) => e.claim.toLowerCase()));
  const signals = { ...research.signals };
  for (const dropped of droppedEvidence) {
    const claim = dropped.split(" (cited ")[0].toLowerCase();
    if (supported.has(claim)) continue;
    for (const key of SIGNALS) {
      if (key in signals && claim.includes(key.replace(/_/g, " "))) {
        (signals as Record<string, unknown>)[key] = null;
      }
    }
  }

  return {
    research: { ...research, evidence, use_cases: useCases, signals },
    droppedEvidence,
    droppedUseCases,
  };
}

/** Compare URLs the way a person would: ignore scheme, www, trailing slash. */
function canonical(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}
