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
  /**
   * The sentence carrying the privacy notice, in this frame's language.
   *
   * `{url}` is replaced. It sits beside the unsubscribe line and says where
   * the address came from, because that is the first thing a stranger wants
   * to know and what Art. 14(2)(f) requires to be said. It belongs to the
   * frame for exactly the reason the unsubscribe line does: a model-written
   * privacy sentence is a compliance failure waiting for a bad day.
   *
   * Every frame has one. A frame without it is a language we can draft in and
   * must not send in, and check-mail-privacy fails rather than let a new
   * frame be added quietly without one.
   */
  privacy: string;
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
    privacy: "Where I got your address, what I hold and how to object: {url}",
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
    privacy: "Where I found your address, what I hold about you and how to object: {url}",
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
    // The notice itself is published in English and German only. The Arabic
    // frame says so plainly rather than pretending, and still links: a reader
    // who is told the page is in English can decide, which is better than a
    // link whose language is a surprise.
    privacy: "مصدر عنوان بريدكم والبيانات التي نحتفظ بها وكيفية الاعتراض (بالإنجليزية): {url}",
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
    privacy:
      "Ihre Kontaktdaten stammen aus einem öffentlichen Unternehmensverzeichnis bzw. Ihrer Website. " +
      "Wie wir sie verarbeiten und wie Sie nach Art. 21 DSGVO widersprechen: {url}",
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

/**
 * What stands in for the unsubscribe URL while nothing can send.
 *
 * Deliberately not a link. A drafted body is stored, shown in the approval
 * queue, and occasionally copied out by hand, so a plausible-looking dead URL
 * is the one thing that must not be in it — and `{token}`, written literally,
 * was exactly that. The reply-STOP sentence in front of this is a real opt-out
 * and `looksLikeOptOut` honours it, so the draft still offers a way out. It
 * just stops pretending to a mechanism nobody has built.
 */
export const NO_UNSUBSCRIBE_LINK = "[no unsubscribe link — nothing is sent from here yet]";

/**
 * What stands in for the privacy notice while it cannot be published.
 *
 * The same reasoning as `NO_UNSUBSCRIBE_LINK`, and the same trap avoided. The
 * notice has to name a controller, and until there is a company there is none
 * to name, so `scripts/build-site.ts` does not publish the page. A drafted
 * body must therefore not contain a plausible-looking belline.ai URL that
 * returns a 404 — least of all in the one sentence that tells somebody how to
 * find out what we hold about them.
 */
export const NO_PRIVACY_NOTICE = "[no privacy notice yet — the company that would be named on it does not exist]";

/**
 * Where a demo link must point.
 *
 * This defaulted to https://belline.ai, which is the marketing site, so every
 * demo link in every draft sent a prospect to the homepage instead of to their
 * own recording on the app. That is not a degraded email; it is a broken
 * promise in the first message a business ever gets from us, and the email has
 * no other job than earning that one click.
 *
 * So a run refuses to start rather than write a hundred of them. It lives here
 * rather than in run.ts so that it can be tested without dragging in the
 * database client and the model call.
 */
export function resolvePublicOrigin(env: Record<string, string | undefined> = process.env): string {
  const origin = (env.PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (!origin) {
    throw new Error(
      "PUBLIC_ORIGIN is not set, so every demo link in this run would point nowhere. " +
        "Set it to the origin that serves the demos (https://app.belline.ai) and run again.",
    );
  }
  if (!/^https?:\/\//i.test(origin)) {
    throw new Error(`PUBLIC_ORIGIN is not a URL: ${origin}`);
  }
  if (/^https?:\/\/(www\.)?belline\.ai$/i.test(origin)) {
    throw new Error(
      "PUBLIC_ORIGIN is the marketing site (belline.ai), which does not serve demos. " +
        "Every prospect would land on the homepage instead of their own recording. " +
        "Use the app origin (https://app.belline.ai).",
    );
  }
  return origin;
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
  /** Null until there is a sender that can mint a token and honour a click. */
  unsubscribeUrl: string | null;
  /** Null until the notice can name a controller and therefore be published. */
  privacyUrl: string | null;
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
    `${input.frame.unsubscribe} ${input.unsubscribeUrl ?? NO_UNSUBSCRIBE_LINK}`,
    input.frame.privacy.replace("{url}", input.privacyUrl ?? NO_PRIVACY_NOTICE),
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
