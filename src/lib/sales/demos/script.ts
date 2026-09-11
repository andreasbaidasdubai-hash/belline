import { z } from "zod";
import { structured } from "../llm/call";

/**
 * The Demo Generation Agent — the writing half.
 *
 * Produces a 30–60 second simulated phone call between a member of the public
 * and Belline answering as *this specific business*, built only from what
 * their own website says. It is the centre of the funnel: the email exists to
 * deliver it, and the landing page exists to play it.
 *
 * It is also the single most dangerous artefact this system produces, because
 * it speaks in a real business's name. So the guards are strict and enforced
 * in code:
 *
 *   · no price, fee or currency amount unless it appears verbatim in the
 *     research evidence — invented pricing is the fastest way to turn a demo
 *     into a complaint
 *   · no named staff member, because getting a dentist's name wrong is worse
 *     than using none
 *   · no clinical or medical advice of any kind
 *   · a spoken disclosure that this is a demonstration
 */

const TurnSchema = z.object({
  role: z.enum(["caller", "agent"]),
  text: z.string().min(2).max(320),
});

export const DemoScriptSchema = z.object({
  /** One line naming the situation, shown on the landing page. */
  scenario: z.string().min(10).max(160),
  turns: z.array(TurnSchema).min(6).max(14),
  /** What the prospect is invited to try on the live line. */
  try_this: z.string().min(10).max(160),
});

export type DemoScript = z.infer<typeof DemoScriptSchema>;

const INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    scenario: {
      type: "string",
      description:
        "One line describing the call, e.g. 'A patient calls at 9pm to book a cleaning'. No marketing language.",
    },
    turns: {
      type: "array",
      description:
        "6 to 14 alternating turns, starting with the agent answering the phone. The whole call must read in 30-60 seconds at natural speaking pace — roughly 110 words total. Short lines.",
      items: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["caller", "agent"] },
          text: { type: "string" },
        },
        required: ["role", "text"],
        additionalProperties: false,
      },
    },
    try_this: {
      type: "string",
      description:
        "One sentence inviting the owner to call the live demo line and try something specific, e.g. 'Call and ask to move an appointment to Saturday.'",
    },
  },
  required: ["scenario", "turns", "try_this"],
  additionalProperties: false,
};

const SYSTEM = `You write short, realistic phone calls that demonstrate Belline — an AI receptionist — answering for a specific business.

The recording is sent to that business's owner. They know their own opening hours, their own services and how their own phone is answered, so anything invented is immediately obvious and destroys the pitch.

How real reception calls sound:
- The agent answers with the business name and an offer to help. One breath, not a speech.
- People interrupt, change their minds, and say "yeah" and "perfect".
- The agent confirms times and names back, because that is what stops mistakes.
- Nobody explains what they are. The agent never says it is an AI unless asked.
- Turns are SHORT. Six to twelve words is normal. A monologue is the tell of a bad demo.

Hard rules:
- Use ONLY services, treatments and opening hours that appear in the material provided.
- Never state a price, fee, deposit or currency amount. Not even an approximate one.
- Never use a staff member's name.
- Never give clinical, medical or dental advice. If the caller asks for any, the agent offers an appointment or says a clinician will call back.
- Do not mention competitors, and do not claim the business currently misses calls.

Write the call so it shows the moment that matters: the phone being answered when it otherwise would not have been.`;

export interface DemoScriptInput {
  agentId: number;
  leadId: number;
  companyName: string;
  city: string | null;
  vertical: string | null;
  /** The research summary, signals and evidence quotes — the only grounding. */
  grounding: string;
  /** The vertical's own vocabulary: patient / client / guest. */
  customerWord: string;
}

export interface DemoScriptOutput {
  script: DemoScript;
  model: string;
  costUsd: number;
  promptHash: string;
  /** Guard failures. A non-empty list means this must not be published. */
  problems: string[];
  wordCount: number;
  estimatedSeconds: number;
}

export async function writeDemoScript(input: DemoScriptInput): Promise<DemoScriptOutput> {
  const result = await structured<DemoScript>({
    task: "personalise",
    agentId: input.agentId,
    leadId: input.leadId,
    system: SYSTEM,
    prompt:
      `Business: ${input.companyName}\n` +
      (input.city ? `City: ${input.city}\n` : "") +
      (input.vertical ? `Type: ${input.vertical}\n` : "") +
      `Call their customers "${input.customerWord}s" if you need a word for them.\n\n` +
      `Everything known about this business, from its own website:\n\n${input.grounding}\n\n` +
      `Write the call. Start with the agent answering. Keep the whole thing under 120 words.`,
    toolName: "write_demo_call",
    toolDescription: "Write a short simulated reception call for this business.",
    inputSchema: INPUT_SCHEMA,
    schema: DemoScriptSchema,
    maxTokens: 1500,
  });

  const checked = checkScript(result.value, input.grounding);

  return {
    script: result.value,
    model: result.model,
    costUsd: result.costUsd,
    promptHash: result.promptHash,
    ...checked,
  };
}

/** Roughly 150 words a minute is unhurried reception pace. */
const WORDS_PER_SECOND = 150 / 60;

/**
 * The guards.
 *
 * Pure, exported and tested, because this is the last thing standing between
 * a model's output and a recording that speaks in a real clinic's name.
 */
export function checkScript(
  script: DemoScript,
  grounding: string,
): { problems: string[]; wordCount: number; estimatedSeconds: number } {
  const problems: string[] = [];
  const all = script.turns.map((t) => t.text).join(" ");

  const wordCount = all.trim().split(/\s+/).filter(Boolean).length;
  const estimatedSeconds = Math.round(wordCount / WORDS_PER_SECOND);

  if (estimatedSeconds > 75) {
    problems.push(`too long: about ${estimatedSeconds}s of speech (${wordCount} words)`);
  }
  // The prompt asks for 30–60s; this floor catches a script that is broken
  // rather than merely brisk. Binning a serviceable 20-second call would cost
  // a model call to regenerate something a listener would not complain about.
  if (estimatedSeconds < 15) {
    problems.push(`too short: about ${estimatedSeconds}s of speech`);
  }

  // Any money figure, unless it appears in the source material. Quoting a
  // practice's own published price back to them is fine and realistic;
  // inventing one is a complaint from the person who sets their fees.
  const money = all.match(
    /(?:aed|sar|chf|usd|eur|gbp|\$|£|€|dhs?)\s?\d[\d,.]*|\d[\d,.]*\s?(?:aed|sar|chf|dirhams?|riyals?|francs?)/gi,
  );
  if (money) {
    const source = grounding.toLowerCase();
    const invented = money
      // The match greedily takes a trailing "." from the end of a sentence —
      // "AED 300." would then never match "AED 300" in the source.
      .map((m) => m.trim().replace(/[.,;:]+$/, ""))
      .filter((m) => !source.includes(m.toLowerCase()));
    if (invented.length) {
      problems.push(`states a price not found in the source: ${invented.join(", ")}`);
    }
  }

  // Clinical advice. The live agent already refuses this; the recording must
  // not demonstrate it doing otherwise.
  //
  // Checked per turn and in two parts, because the obvious one-line version
  // ("you have", "that sounds like") rejects "you have an appointment on
  // Thursday" and "that sounds like a hygiene visit" — both of which are
  // exactly what a good demo says. Speculation only counts as advice when it
  // is speculation about a *condition*.
  const PRESCRIBES = /\b(?:you should take|you need to take|I(?:'d| would)? recommend|prescrib\w*|diagnos\w*)\b/i;
  const SPECULATES = /\b(?:that sounds like|it'?s probably|it could be|you (?:probably |likely )?have)\b/i;
  const CONDITION =
    /\b(?:infection|abscess|cavity|cavities|decay|gingivitis|inflammation|ulcer|gum disease|nerve|allerg\w+|antibiotics?|painkillers?|ibuprofen|paracetamol|amoxicillin)\b/i;

  for (const turn of script.turns) {
    if (turn.role !== "agent") continue;
    if (PRESCRIBES.test(turn.text) || (SPECULATES.test(turn.text) && CONDITION.test(turn.text))) {
      problems.push(`clinical advice in an agent turn: "${turn.text.slice(0, 80)}"`);
      break;
    }
  }

  if (script.turns[0]?.role !== "agent") {
    problems.push("does not start with the phone being answered");
  }

  // Alternating speakers. Two agent turns in a row is a monologue, which is
  // exactly what a demo must not sound like.
  for (let i = 1; i < script.turns.length; i++) {
    if (script.turns[i].role === script.turns[i - 1].role) {
      problems.push(`two ${script.turns[i].role} turns in a row at position ${i + 1}`);
      break;
    }
  }

  const longest = Math.max(
    ...script.turns
      .filter((t) => t.role === "agent")
      .map((t) => t.text.trim().split(/\s+/).length),
  );
  if (longest > 34) problems.push(`an agent turn runs to ${longest} words — too long to sound real`);

  if (/\b(?:as an AI|I am an AI|artificial intelligence|language model)\b/i.test(all)) {
    problems.push("the agent explains that it is an AI");
  }

  return { problems, wordCount, estimatedSeconds };
}

/**
 * The spoken disclosure, appended to every recording.
 *
 * Not generated: it is a compliance requirement, it must be identical every
 * time, and a model must not be able to soften it. See COMPLIANCE.md §3.
 */
export function disclosureFor(companyName: string): string {
  return `That was a Belline demonstration, built automatically from ${companyName}'s public website. It is not a real call, and nothing in it was booked.`;
}
