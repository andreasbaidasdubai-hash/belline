import { z } from "zod";
import { structured } from "../llm/call";
import { checkDraft, type DraftParts, type GuardContext, type GuardResult } from "./guards";

/**
 * The Personalisation Agent.
 *
 * Requirement §5, and the one the directive is most emphatic about: do not
 * send generic AI-generated spam. The structure is fixed —
 *
 *   OBSERVATION  something specific, checkable, about *this* practice
 *   PROBLEM      what that costs them, in their terms
 *   SOLUTION     one or two Belline outcomes, never the technology
 *   CTA          a question, not a calendar demand
 *
 * — because the structure is what makes it feel like a note from someone who
 * looked, and the alternative is four paragraphs of adjectives.
 *
 * The email's real payload is the demo link. The copy exists to earn the
 * click, so it is short by design: the recording does the selling.
 */

export const DraftSchema = z.object({
  /** Two, so the send step can A/B them. */
  subjects: z.array(z.string().min(8).max(78)).length(2),
  observation: z.string().min(15).max(300),
  problem: z.string().min(10).max(280),
  solution: z.string().min(10).max(300),
  cta: z.string().min(8).max(200),
});

export type Draft = z.infer<typeof DraftSchema>;

const INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    subjects: {
      type: "array",
      description:
        "Exactly two subject lines to test against each other. Lower case except proper nouns, under 60 characters, no colons-as-headlines, no emoji. They should read like a person wrote them to one recipient.",
      items: { type: "string" },
    },
    observation: {
      type: "string",
      description:
        "One sentence naming something specific and verifiable about this business, taken from the research. Not a compliment. The test: could this sentence be sent to any other practice? If yes, it is wrong.",
    },
    problem: {
      type: "string",
      description:
        "One sentence on what that costs them, in their own terms — a call at 9pm nobody answers, a patient who rings the next practice. Never accuse them of being bad at their job.",
    },
    solution: {
      type: "string",
      description:
        "One or two sentences on what Belline does about it, as an outcome. Never name the technology. Never say 'AI'. Mention that it works alongside the existing front desk rather than replacing anyone.",
    },
    cta: {
      type: "string",
      description:
        "One short closing line. A question they can answer in five words, or an invitation to listen. Never propose a meeting time, never ask for a call, never say 'let me know a good time'.",
    },
  },
  required: ["subjects", "observation", "problem", "solution", "cta"],
  additionalProperties: false,
};

const SYSTEM = `You write one short email to the owner of a service business, on behalf of Belline — an assistant that answers a business's phone when nobody else can.

The email's job is to earn one click on a demo recording. It is not a pitch and it is not a sales letter. It should read like a note from someone who spent two minutes looking at their website and thought it was worth telling them something.

What good looks like:
- Specific. The first sentence names something true about THIS business that you could only know by looking.
- Short. Under ninety words across the whole thing. Shorter is better.
- Plain. The vocabulary of someone typing quickly, not composing.
- Respectful of their business. They are not failing; their phone is simply not answered at 9pm, which is true of nearly everyone.
- Outcome-led. Fewer missed calls, more appointments kept, less pressure on the front desk. Never the machinery.

What fails immediately:
- Anything that could be sent to another practice unchanged.
- Naming the technology. Never write "AI", "artificial intelligence", "powered by" or "chatbot".
- Any number, price, statistic or customer count not present in the material you are given.
- Promising they will "never miss a call".
- Flattery, or telling them their business is impressive.
- Asking for a meeting, a call, or fifteen minutes.

You are writing to someone who gets twenty of these a week and deletes them all. The only thing that makes this one different is that it clearly is about them.`;

export interface PersonaliseInput {
  agentId: number;
  leadId: number;
  companyName: string;
  city: string | null;
  vertical: string | null;
  customerWord: string;
  forbiddenCustomerWords: string[];
  /** Research summary, signals and quotes. The only permitted source. */
  grounding: string;
  /** What the demo recording actually contains, so the copy can point at it. */
  demoScenario: string | null;
  /** Belline services this agent may cite. */
  allowedServices: string[];
  /** Tone from the agent's resolved config. */
  tone: string;
  maxWords: number;
  /** Recently sent bodies, for the anti-template check. */
  recentBodies: string[];
}

export interface PersonaliseOutput {
  draft: Draft;
  guard: GuardResult;
  model: string;
  costUsd: number;
  promptHash: string;
}

export async function personalise(input: PersonaliseInput): Promise<PersonaliseOutput> {
  const result = await structured<Draft>({
    task: "personalise",
    agentId: input.agentId,
    leadId: input.leadId,
    system: SYSTEM,
    prompt: [
      `Business: ${input.companyName}`,
      input.city ? `City: ${input.city}` : "",
      input.vertical ? `Type: ${input.vertical}` : "",
      `Call their customers "${input.customerWord}s".`,
      `Tone: ${input.tone}`,
      `Hard limit: ${input.maxWords} words across observation, problem, solution and CTA combined.`,
      "",
      `What Belline can do for them (use at most two, as outcomes): ${input.allowedServices
        .map((s) => s.replace(/_/g, " "))
        .join(", ")}`,
      "",
      input.demoScenario
        ? `The email links to a 40-second recording of Belline answering their phone. In it: ${input.demoScenario}\nYou may refer to what the recording contains.`
        : "",
      "",
      `Everything known about this business, from its own website. Use nothing else:`,
      "",
      input.grounding,
    ]
      .filter(Boolean)
      .join("\n"),
    toolName: "write_outreach",
    toolDescription: "Write one short, specific outreach email for this business.",
    inputSchema: INPUT_SCHEMA,
    schema: DraftSchema,
    maxTokens: 1200,
  });

  const ctx: GuardContext = {
    companyName: input.companyName,
    grounding: input.grounding,
    allowedClaims: input.allowedServices,
    customerWord: input.customerWord,
    forbiddenCustomerWords: input.forbiddenCustomerWords,
    maxWords: input.maxWords,
    recentBodies: input.recentBodies,
  };

  // Both subjects go through the guards; the worse of the two decides, because
  // the send step may pick either.
  const parts: DraftParts = {
    subject: result.value.subjects.join(" "),
    observation: result.value.observation,
    problem: result.value.problem,
    solution: result.value.solution,
    cta: result.value.cta,
  };

  return {
    draft: result.value,
    guard: checkDraft(parts, ctx),
    model: result.model,
    costUsd: result.costUsd,
    promptHash: result.promptHash,
  };
}
