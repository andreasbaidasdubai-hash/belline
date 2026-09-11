/**
 * Outreach frames.
 *
 * The template supplies everything a model must not be trusted with — the
 * greeting form, the sign-off, the demo link, the unsubscribe line and the
 * physical sender address — and the model supplies only the personalised
 * middle. Never the other way round: a generated unsubscribe line is a
 * compliance failure waiting for a bad day, and a generated sign-off is how
 * "Best regards, [Your Name]" reaches a real inbox.
 *
 * Resolution is `country+vertical+language → country+language → language →
 * default`, so a new market works on day one with the default frame and gets
 * better as frames are written for it.
 */

export interface Frame {
  key: string;
  language: string;
  /** `{first}` is replaced, or the whole line is dropped when nobody is named. */
  greeting: string;
  /** Used when we only have a role, not a person. */
  greetingFallback: string;
  signoff: string;
  /** The one-line invitation that wraps the demo URL. */
  demoCta: string;
  /** Offered after the recording — the live line is the conversion moment. */
  liveCta: string;
  unsubscribe: string;
  direction?: "rtl";
}

const FRAMES: Frame[] = [
  {
    key: "default:en",
    language: "en",
    greeting: "Hi {first},",
    greetingFallback: "Hello,",
    signoff: "Andreas\nBelline",
    demoCta: "▶ Hear your Belline demo",
    liveCta:
      "No presentation and no sales call needed — you can also ring Belline yourself and test it as a customer would.",
    unsubscribe: "Not for you? Reply with STOP and I won't write again.",
  },
  {
    // The Gulf reads as more formal than UK/US outbound. Same brevity, less
    // familiarity — "Hi Ahmed," lands as presumptuous from a stranger here.
    key: "AE:en",
    language: "en",
    greeting: "Dear {first},",
    greetingFallback: "Good morning,",
    signoff: "Andreas Baidas\nBelline",
    demoCta: "▶ Listen to your Belline demo",
    liveCta:
      "No meeting and no presentation — you can also call Belline yourself and try it as one of your patients would.",
    unsubscribe: "If you would rather not hear from me, reply STOP and I will not write again.",
  },
  {
    key: "AE:ar",
    language: "ar",
    greeting: "السيد/ة {first} المحترم/ة،",
    greetingFallback: "تحية طيبة،",
    signoff: "أندرياس بيداس\nBelline",
    demoCta: "▶ استمع إلى النموذج الخاص بعيادتك",
    liveCta:
      "بدون اجتماع وبدون عرض تقديمي — يمكنك أيضًا الاتصال بـ Belline بنفسك وتجربته كما يفعل مرضاك.",
    unsubscribe: "إذا كنت تفضل عدم تلقي رسائل مني، اكتب STOP ولن أراسلك مرة أخرى.",
    direction: "rtl",
  },
  {
    // Switzerland: Sie, no first names, and a shorter sequence — UWG Art.
    // 3(1)(o) makes a long unsolicited approach materially harder to defend.
    key: "CH:de",
    language: "de",
    greeting: "Guten Tag {first}",
    greetingFallback: "Guten Tag",
    signoff: "Andreas Baidas\nBelline",
    demoCta: "▶ Ihr Belline-Beispiel anhören",
    liveCta:
      "Kein Termin und keine Präsentation — Sie können Belline auch selbst anrufen und es wie ein Patient testen.",
    unsubscribe:
      "Falls Sie keine weiteren Nachrichten wünschen, antworten Sie mit STOPP — dann schreibe ich nicht wieder.",
  },
];

export function resolveFrame(input: {
  countryCode?: string | null;
  language?: string | null;
}): Frame {
  const country = input.countryCode?.toUpperCase();
  const language = (input.language ?? "en").toLowerCase();

  return (
    FRAMES.find((f) => f.key === `${country}:${language}`) ??
    FRAMES.find((f) => f.key === `default:${language}`) ??
    FRAMES.find((f) => f.language === language) ??
    FRAMES[0]
  );
}

export interface AssembleInput {
  frame: Frame;
  firstName?: string | null;
  /** The model's personalised middle, already through the guards. */
  observation: string;
  problem: string;
  solution: string;
  cta: string;
  demoUrl: string;
  /** Shown under the demo link — what to try on the live line. */
  tryThis?: string | null;
  unsubscribeUrl: string;
  senderAddress: string;
}

/**
 * Build the finished email.
 *
 * Deliberately plain text shaped: no images, no tracking pixel, no HTML
 * scaffolding. A cold email that looks like a newsletter gets filed like one,
 * and the highest-deliverability outbound looks like a person typed it.
 */
export function assemble(input: AssembleInput): { body: string; plain: string } {
  const greeting = input.firstName
    ? input.frame.greeting.replace("{first}", input.firstName)
    : input.frame.greetingFallback;

  const lines = [
    greeting,
    "",
    // Observation and problem read as one short paragraph. Split across two,
    // the observation sounds like a preamble rather than the reason for
    // writing.
    `${input.observation} ${input.problem}`.trim(),
    "",
    input.solution.trim(),
    "",
    `${input.frame.demoCta}: ${input.demoUrl}`,
  ];

  if (input.tryThis) lines.push("", input.tryThis.trim());

  lines.push(
    "",
    input.frame.liveCta,
    "",
    input.cta.trim(),
    "",
    input.frame.signoff,
    "",
    "—",
    input.senderAddress,
    `${input.frame.unsubscribe} ${input.unsubscribeUrl}`,
  );

  const plain = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { body: plain, plain };
}

/** Words in the part a person actually reads — the frame is not the pitch. */
export function personalisedWordCount(input: {
  observation: string;
  problem: string;
  solution: string;
  cta: string;
}): number {
  return `${input.observation} ${input.problem} ${input.solution} ${input.cta}`
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}
