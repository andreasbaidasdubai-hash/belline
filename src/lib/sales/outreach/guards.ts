/**
 * Pre-send guards for outreach copy.
 *
 * The last thing between a model's output and a stranger's inbox, and the
 * place where "sell the outcome, not the technology" stops being advice and
 * becomes a check that fails.
 *
 * Everything here is pure and tested. None of it is a prompt instruction,
 * because a prompt instruction is followed *most* of the time, and a draft
 * that breaks one of these rules one time in twenty is worse than one that
 * breaks it every time — it survives review and reaches a real practice owner.
 */

export interface DraftParts {
  subject: string;
  observation: string;
  problem: string;
  solution: string;
  cta: string;
}

export interface GuardContext {
  companyName: string;
  /** Quotes and summary from the research record — the only permitted source. */
  grounding: string;
  /** Slugs this agent may sell, with the claims each is allowed to make. */
  allowedClaims: string[];
  /** The vertical's own word: patient / client / guest. */
  customerWord: string;
  /** Wrong words for this vertical — a clinic hearing "guest" has lost the room. */
  forbiddenCustomerWords: string[];
  maxWords: number;
  /** Bodies of the last N sent messages, for the anti-template check. */
  recentBodies: string[];
}

export interface GuardResult {
  /** Anything here means the draft goes to a human, never straight out. */
  problems: string[];
  /** Worth knowing, not worth blocking. */
  warnings: string[];
  wordCount: number;
  similarity: number;
}

/**
 * Phrases that mark an email as machine-written to anyone who reads outbound.
 *
 * The list is short and specific on purpose. A long banned-word list produces
 * contorted copy that reads oddly in a different way; these are the ones that
 * genuinely announce "a tool sent this".
 */
const BANNED = [
  /\bI hope this (?:email |message )?finds you well\b/i,
  /\bI hope you(?:'re| are) doing well\b/i,
  /\brevolutionary\b/i,
  /\bcutting[- ]edge\b/i,
  /\bgame[- ]?chang(?:er|ing)\b/i,
  /\bleverage\b/i,
  /\bsynerg(?:y|ies|istic)\b/i,
  /\bseamless(?:ly)?\b/i,
  /\bstate[- ]of[- ]the[- ]art\b/i,
  /\bunlock (?:the )?(?:potential|power)\b/i,
  /\bin today'?s (?:fast[- ]paced |competitive )?world\b/i,
  /\bquick question\b/i,
  /\bcircle back\b/i,
  /\breach out\b/i,
  /\btouch base\b/i,
];

/**
 * Selling the technology rather than the outcome.
 *
 * A dentist does not want an AI; they want their phone answered at nine at
 * night. Naming the machinery invites a conversation about the machinery,
 * which is the conversation that loses.
 */
const TECH_TALK = [
  /\bAI[- ]powered\b/i,
  /\bpowered by (?:AI|artificial intelligence|GPT|LLM)/i,
  /\bartificial intelligence\b/i,
  /\bmachine learning\b/i,
  /\bneural\b/i,
  /\bGPT\b/,
  /\bLLM\b/,
  /\bnatural language processing\b/i,
  /\bchatbot\b/i,
];

/**
 * What an email must not say Belline does, because it does not yet.
 *
 * Mirrors the `not-yet` features in billing/plans.ts and the FAQ on the
 * website. Remove a line here the day the thing works, not before.
 */
const NOT_LIVE: { pattern: RegExp; why: string }[] = [
  { pattern: /\b(?:arabic|bilingual|multilingual|multiple languages|any language|in (?:their|your) (?:own )?language)\b/i, why: "English only" },
  { pattern: /\b(?:puts? (?:them|you|the (?:patient|caller|client|guest)s?) through|transfers? (?:the |a )?(?:call|caller|patient)s?|live transfer|patch(?:es)? (?:them|it|the call) through)\b/i, why: "no live transfer" },
  { pattern: /\bwhats\s?app\b/i, why: "WhatsApp not connected" },
  { pattern: /\b(?:fresha|sevenrooms|opentable|treatwell|dentally|dentrix|zenoti|phorest|booksy|eat app)\b/i, why: "no booking-system integrations" },
  { pattern: /\b(?:reminders?|sms|texts? (?:them|you|patients?|clients?|guests?|callers?))\b/i, why: "no reminders or texts" },
];

const MONEY =
  /(?:aed|sar|chf|usd|eur|gbp|\$|£|€|dhs?)\s?\d[\d,.]*|\d[\d,.]*\s?(?:aed|sar|chf|dirhams?|riyals?|francs?)/gi;

const PRICING_WORDS =
  /\b(?:per month|monthly fee|subscription|pricing|our price|costs? only|free trial|discount|% off)\b/i;

export function checkDraft(parts: DraftParts, ctx: GuardContext): GuardResult {
  const problems: string[] = [];
  const warnings: string[] = [];

  const personalised = `${parts.observation} ${parts.problem} ${parts.solution} ${parts.cta}`.trim();
  const all = `${parts.subject} ${personalised}`;
  const wordCount = personalised.split(/\s+/).filter(Boolean).length;

  // --- length ------------------------------------------------------------
  if (wordCount > ctx.maxWords) {
    problems.push(`${wordCount} words of personalised copy — the cap is ${ctx.maxWords}`);
  }
  if (wordCount < 25) {
    warnings.push(`only ${wordCount} words — may read as thin`);
  }
  if (parts.subject.length > 78) {
    problems.push(`subject is ${parts.subject.length} characters — it will be truncated`);
  }
  if (/^(?:re|fwd?):/i.test(parts.subject.trim())) {
    // Faking a reply to a conversation that never happened.
    problems.push("subject pretends to be a reply");
  }

  // --- honesty about the prospect ----------------------------------------
  const source = ctx.grounding.toLowerCase();

  // Numbers are where fabrication hides: "your four locations" is checkable,
  // wrong half the time, and fatal when wrong. Every figure in the copy must
  // appear in the research.
  //
  // Checked in both forms, because the two sides spell numbers differently:
  // research quotes a page saying "thirteen clinics", the model writes "13",
  // and a naive string match calls a correct figure invented while letting a
  // wrong spelled-out one through — which is the worse direction to fail in.
  for (const { text, value, isClaim } of numbersIn(personalised)) {
    // Only figures that are claims *about them*. "Worth forty seconds of your
    // time" is a fact about our recording, not about their practice, and
    // flagging it would reject every well-written draft.
    if (!isClaim) continue;
    if (mentionsNumber(source, value)) continue;
    problems.push(`states "${text}", which is not in the research`);
  }

  const money = personalised.match(MONEY);
  if (money) problems.push(`quotes a price: ${money.join(", ")}`);
  if (PRICING_WORDS.test(all)) problems.push("discusses pricing or commercial terms");

  // --- honesty about Belline ---------------------------------------------
  if (/\b(?:hundreds|thousands|\d+\+?) of (?:clinics|practices|businesses|customers)\b/i.test(all)) {
    problems.push("claims a customer base");
  }
  if (/\b(?:trusted by|used by|our clients include|case study)\b/i.test(all)) {
    problems.push("claims customers or case studies");
  }
  if (/\b(?:guarantee|guaranteed|never miss(?:es)? a(?: single)? call)\b/i.test(all)) {
    // "Never miss a call" is a promise no phone system can keep.
    problems.push("makes an absolute promise");
  }

  // Capabilities that are not live. Checked only in what the email says
  // Belline does — "your multilingual team" in the observation is a true fact
  // about them, "answers in English or Arabic" in the solution is a false one
  // about us. A research agent drafted exactly that sentence to a Dubai
  // practice, and nothing stopped it.
  const aboutUs = `${parts.solution} ${parts.cta}`;
  for (const { pattern, why } of NOT_LIVE) {
    const hit = aboutUs.match(pattern);
    if (hit) problems.push(`promises something that is not live yet (${why}): "${hit[0]}"`);
  }

  // --- tone ---------------------------------------------------------------
  for (const pattern of BANNED) {
    const hit = all.match(pattern);
    if (hit) problems.push(`uses "${hit[0]}"`);
  }
  for (const pattern of TECH_TALK) {
    const hit = all.match(pattern);
    if (hit) problems.push(`sells the technology, not the outcome: "${hit[0]}"`);
  }
  const bangs = (all.match(/!/g) ?? []).length;
  if (bangs > 1) problems.push(`${bangs} exclamation marks`);

  // --- vocabulary ---------------------------------------------------------
  for (const wrong of ctx.forbiddenCustomerWords) {
    if (new RegExp(`\\b${wrong}s?\\b`, "i").test(personalised)) {
      problems.push(`calls their ${ctx.customerWord}s "${wrong}s"`);
    }
  }

  // --- placeholders that escaped ------------------------------------------
  const placeholder = all.match(/\[[A-Za-z _]+\]|\{\{?[a-z_]+\}?\}|\bYour Name\b/i);
  if (placeholder) problems.push(`unfilled placeholder: ${placeholder[0]}`);

  // Good copy names the branch or the street rather than reciting the full
  // registered name — "Jumeirah Al Wasl" reads as written by someone who
  // looked, where "Dr. Joy Dental Clinic, Jumeirah Al Wasl Road" reads as a
  // mail merge. So this looks for any distinctive word from the name, not the
  // whole string.
  const distinctive = ctx.companyName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (w) =>
        w.length > 3 &&
        !["dental", "clinic", "clinics", "centre", "center", "medical", "dubai", "road", "branch"].includes(
          w,
        ),
    );
  const body = personalised.toLowerCase();
  if (distinctive.length > 0 && !distinctive.some((w) => body.includes(w))) {
    warnings.push("does not name the business or a branch");
  }

  // --- not a template in disguise -----------------------------------------
  const similarity = maxSimilarity(personalised, ctx.recentBodies);
  if (similarity >= 0.85) {
    problems.push(`${Math.round(similarity * 100)}% similar to a message already sent`);
  } else if (similarity >= 0.7) {
    warnings.push(`${Math.round(similarity * 100)}% similar to a recent message`);
  }

  return { problems, warnings, wordCount, similarity };
}

/**
 * Number words this domain actually uses: branch counts, practitioner counts,
 * opening hours. Nothing here needs to parse "three hundred and forty-two".
 */
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};

const WORD_FOR: Record<number, string> = Object.fromEntries(
  Object.entries(NUMBER_WORDS).map(([word, n]) => [n, word]),
);

/**
 * Nouns that turn a number into a checkable claim about the business.
 *
 * "Thirteen clinics" is a fact about them and must be sourced. "Forty seconds"
 * is a fact about our recording. Only the first kind can be wrong in a way
 * that embarrasses us in front of the person who knows the answer.
 */
const FACT_NOUNS =
  /^\W*(?:\w+\W+){0,2}(?:clinics?|branch(?:es)?|locations?|sites?|practices?|surgeries|dentists?|doctors?|practitioners?|stylists?|therapists?|staff|team|reviews?|ratings?|patients?|clients?|guests?|chairs?|rooms?|tables?|covers?|years?)\b/i;

/** Every figure the copy states, with whether it is a claim about the business. */
export function numbersIn(text: string): { text: string; value: number; isClaim: boolean }[] {
  const out: { text: string; value: number; isClaim: boolean }[] = [];

  const push = (match: RegExpMatchArray, value: number) => {
    const after = text.slice((match.index ?? 0) + match[0].length);
    out.push({ text: match[1], value, isClaim: FACT_NOUNS.test(after) });
  };

  for (const match of text.matchAll(/\b(\d[\d,]*)(?:\.\d+)?\b/g)) {
    const value = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(value)) push(match, value);
  }

  const words = Object.keys(NUMBER_WORDS).join("|");
  for (const match of text.matchAll(new RegExp(`\\b(${words})\\b`, "gi"))) {
    push(match, NUMBER_WORDS[match[1].toLowerCase()]);
  }

  return out;
}

/** True when the source states this figure in either form. */
export function mentionsNumber(source: string, value: number): boolean {
  const lower = source.toLowerCase();
  // Word-bounded, so "13" does not match inside "2013" and "one" does not
  // match inside "phone" — the second of which would wave through almost
  // anything, since every one of these emails mentions a phone.
  if (new RegExp(`\\b${value}\\b`).test(lower)) return true;
  const word = WORD_FOR[value];
  return word ? new RegExp(`\\b${word}\\b`).test(lower) : false;
}

/**
 * Jaccard overlap on word trigrams.
 *
 * Cheap, no dependency, and it measures the thing that matters: whether two
 * emails are the same sentences with the business name swapped. Cosine over
 * embeddings would be better at paraphrase and far more than this needs —
 * the failure mode here is literal repetition, not clever rewording.
 */
export function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const words = s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
    const out = new Set<string>();
    for (let i = 0; i + 2 < words.length; i++) out.add(words.slice(i, i + 3).join(" "));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return shared / (A.size + B.size - shared);
}

function maxSimilarity(text: string, others: string[]): number {
  let worst = 0;
  for (const other of others) worst = Math.max(worst, similarity(text, other));
  return worst;
}
