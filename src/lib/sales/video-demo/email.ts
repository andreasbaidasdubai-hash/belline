import { vocabularyFor } from "../config/defaults";
import { checkDraft, type DraftParts } from "../outreach/guards";
import { resolveFrame } from "../outreach/templates";
import { groundingOf, type ProspectFacts } from "./context";
import type { TouchPolicy } from "./store";

/**
 * The email that carries a video-demo link.
 *
 * A draft, and only ever a draft. Nothing in this module or its route can
 * send: staff copy it, or open it in their own mail app through a `mailto:`
 * link, and that click is what gets recorded. There is no sender behind the
 * sales console, and this is not the place to build one quietly.
 *
 * The personalised middle is written from the stored research, in the
 * observation / problem / solution / call-to-action shape of the outreach
 * drafter, and put through the same guards (`checkDraft`). The frame — the
 * greeting, the sign-off, the sender's postal address and the reply-STOP
 * opt-out — comes from the outreach frames, never from the draft.
 *
 * Compliance is checked here rather than at a send that does not exist: the
 * suppression list, the lead's minimum spacing between touches and its 90-day
 * cap. Any of them failing blocks both the copy and the mail-app buttons.
 */

export interface EmailDraft {
  to: string | null;
  subject: string;
  text: string;
  html: string;
  /** Null when anything blocks it. */
  mailto: string | null;
  demoUrl: string;
  thumbnailUrl: string;
  problems: string[];
  warnings: string[];
  /** Compliance and link state. Any entry means: do not send this. */
  blocked: string[];
  words: number;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The name as a person writes it: without "LLC", "FZ-LLC" and the like. */
function shortName(name: string): string {
  return name.replace(/\s*[,-]?\s*\b(?:llc|l\.l\.c\.|fz-?llc|fze|ltd|limited|gmbh|ag|sa)\.?$/i, "").trim() || name;
}

export function draftParts(f: ProspectFacts): DraftParts {
  const name = shortName(f.businessName);
  const vocab = vocabularyFor(f.verticalSlug);
  const channel = f.channels.find((c) => /phone|WhatsApp|online booking/i.test(c));
  const saw = channel
    ? channel.replace(/^lists/, "list").replace(/^takes/, "take").replace(/^books/, "book").replace(/^has/, "have")
    : null;

  const observation = saw
    ? `I was looking at ${name}${f.city ? ` in ${f.city}` : ""} and saw that you ${saw}.`
    : `I was looking at ${name}'s website${f.city ? ` in ${f.city}` : ""}.`;
  const problem = f.painPoints.some((p) => /after hours/.test(p))
    ? `An enquiry that comes in after you close waits until morning, and by then a ${vocab.word} may have gone elsewhere.`
    : `When the team is busy with a ${vocab.word}, the next call or message waits, and some of those ${vocab.word}s go elsewhere.`;
  const solution =
    "Belline answers your calls, website chats and a second WhatsApp number from your own information and passes the rest to your team, alongside your front desk rather than instead of it.";
  const cta = `It isn't a recording: Belle talks you through it for ${name} herself and answers your questions. Worth two minutes?`;
  return {
    subject: `a 2-minute demo for ${name}`.slice(0, 78),
    observation,
    problem,
    solution,
    cta,
  };
}

export function buildVideoDemoEmail(input: {
  facts: ProspectFacts;
  demoUrl: string;
  thumbnailUrl: string;
  linkActive: boolean;
  suppressed: string | null;
  policy: TouchPolicy;
  senderAddress?: string;
  recentBodies?: string[];
  flagOn?: (flag: string) => boolean;
  now?: number;
}): EmailDraft {
  const f = input.facts;
  const now = input.now ?? Date.now();
  const parts = draftParts(f);
  const vocab = vocabularyFor(f.verticalSlug);
  const guard = checkDraft(parts, {
    companyName: f.businessName,
    grounding: groundingOf(f),
    allowedClaims: [],
    customerWord: vocab.word,
    forbiddenCustomerWords: vocab.forbidden,
    maxWords: 90,
    recentBodies: input.recentBodies ?? [],
    flagOn: input.flagOn,
  });

  const frame = resolveFrame({ countryCode: f.countryCode, language: "en" });
  const senderAddress = input.senderAddress ?? process.env.SENDER_POSTAL_ADDRESS ?? "Belline · Dubai, United Arab Emirates";
  const greeting = f.firstName ? frame.greeting.replace("{first}", f.firstName) : frame.greetingFallback;
  const watch = "▶ Watch your 2-minute demo";
  const aboutDemo =
    "It's a short video conversation with Belle, Belline's AI receptionist: she opens with a personal pitch for your business and then answers your questions. Prefer to type? You can chat with her on the same page.";

  const text = [
    greeting,
    "",
    `${parts.observation} ${parts.problem}`,
    "",
    parts.solution,
    "",
    `${watch}: ${input.demoUrl}`,
    aboutDemo,
    "",
    parts.cta,
    "",
    frame.signoff,
    "",
    "—",
    senderAddress,
    frame.unsubscribe,
  ].join("\n");

  const p = (s: string) => `<p style="margin:0 0 14px;line-height:1.55">${escapeHtml(s).replace(/\n/g, "<br>")}</p>`;
  const html = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;color:#1d1d1f;max-width:560px">`,
    p(greeting),
    p(`${parts.observation} ${parts.problem}`),
    p(parts.solution),
    `<p style="margin:18px 0 6px"><a href="${escapeHtml(input.demoUrl)}" style="text-decoration:none"><img src="${escapeHtml(
      input.thumbnailUrl,
    )}" width="480" height="270" alt="${escapeHtml(`Watch your 2-minute demo for ${shortName(f.businessName)}`)}" style="display:block;border:0;border-radius:14px;max-width:100%;height:auto"></a></p>`,
    `<p style="margin:0 0 14px"><a href="${escapeHtml(input.demoUrl)}" style="color:#0071e3;font-weight:600">${escapeHtml(watch)}</a></p>`,
    p(aboutDemo),
    p(parts.cta),
    p(frame.signoff),
    `<p style="margin:22px 0 0;font-size:12px;color:#6e6e73;line-height:1.5">${escapeHtml(senderAddress)}<br>${escapeHtml(frame.unsubscribe)}</p>`,
    `</div>`,
  ].join("\n");

  const blocked: string[] = [];
  const to = f.contactEmail?.trim() || null;
  if (!to) blocked.push("No email address for this lead.");
  if (input.suppressed) blocked.push(`On the suppression list: ${input.suppressed}.`);
  if (!input.linkActive) blocked.push("The demo link is not active.");
  const { minDaysBetweenTouches, touchCap90d, lastTouchAt, touches90d } = input.policy;
  if (lastTouchAt) {
    const days = (now - Date.parse(lastTouchAt)) / 86_400_000;
    if (days < minDaysBetweenTouches) {
      blocked.push(`Last contact was ${days < 1 ? "today" : `${Math.floor(days)} day(s) ago`}; this lead's minimum spacing is ${minDaysBetweenTouches} days.`);
    }
  }
  if (touches90d >= touchCap90d) blocked.push(`${touches90d} touches in 90 days reaches this lead's cap of ${touchCap90d}.`);
  if (guard.problems.length) blocked.push("The draft failed the outreach guards.");

  const mailto =
    blocked.length === 0 && to
      ? `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(parts.subject)}&body=${encodeURIComponent(text)}`
      : null;

  return {
    to,
    subject: parts.subject,
    text,
    html,
    mailto,
    demoUrl: input.demoUrl,
    thumbnailUrl: input.thumbnailUrl,
    problems: guard.problems,
    warnings: guard.warnings,
    blocked,
    words: guard.wordCount,
  };
}
