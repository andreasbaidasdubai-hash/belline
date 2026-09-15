import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { Vertical } from "../types";
import { findUserByEmail, id, listLeads, saveLead } from "../store";
import { signLoginToken } from "../auth";
import { checkShape } from "../leads/email";
import { findRecentDuplicate, normalisePhone, type Lead } from "../leads";
import { appOrigin, createProspectDemo } from "../prospect";
import { signUp } from "../onboarding";
import { sendEmail } from "../providers/email";
import { sendSms, smsEnabled } from "../providers/sms";
import {
  TRIAL,
  annualPerMonth,
  checkSelection,
  money,
  periodFee,
  priceOf,
  publicLines,
  sellable,
  type ProductId,
} from "../billing/plans";
import type { ToolContext, ToolOutcome } from "./tools";

/**
 * Belle's sales hands — only on Belline's own venue.
 *
 * She used to be able to do one thing for a prospect: book a call with a
 * person. Now she can do what the call was for. Every tool validates and
 * returns a sentence she can say, the same as the booking tools, and each
 * guards the thing a salesperson is most tempted to get wrong:
 *
 *   `quote` reads prices from the catalogue and refuses discounts, contracts
 *   and guarantees in code, so no prompt can talk her into one.
 *
 *   `start_trial` refuses an address she has not read back and had confirmed,
 *   and sends the sign-in link by email only — never into the chat, because
 *   whoever holds that link is signed in.
 *
 *   `build_demo` goes through the same public-URL guard as the dashboard, and
 *   is rate-limited per conversation because each one costs a model call.
 */

export const SALES_TOOL_NAMES = ["record_lead", "quote", "build_demo", "start_trial", "send_checkout"] as const;

const HELLO = "hello@belline.ai";
const DEMOS_PER_CONVERSATION = 2;
const demosBuilt = new Map<string, number>();

export function salesTools(): Anthropic.Tool[] {
  return [
    {
      name: "record_lead",
      description:
        "Save a prospect as soon as you know who they are and how to reach them, so nobody is lost if the conversation drops. Call it again when you learn more.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          business: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          website: { type: "string" },
          vertical: { type: "string", description: "What the business does, e.g. dental clinic, salon, restaurant." },
          venues: { type: "string", description: "How many locations." },
          pain: { type: "string", description: "How they lose calls or bookings today, in their words." },
          stage: { type: "string", enum: ["curious", "interested", "wants_demo", "wants_trial", "ready_to_buy", "wants_person"] },
        },
        required: ["business", "stage"],
      },
    },
    {
      name: "quote",
      description:
        "The only source of prices. Call it before saying any price, allowance or what a plan includes. If they ask for a discount, a contract, a guarantee or a price for several venues, pass that in asks_for.",
      input_schema: {
        type: "object",
        properties: {
          asks_for: { type: "string", enum: ["none", "discount", "contract", "guarantee", "several_venues"] },
        },
      },
    },
    {
      name: "build_demo",
      description:
        "Build the prospect's own demo from their website: their receptionist, with their name, services and hours, to chat with or call. Takes about a minute. Returns a link.",
      input_schema: {
        type: "object",
        properties: {
          website: { type: "string", description: "Their website address." },
          send_to_email: { type: "string", description: "Only if they asked for it by email; read it back first." },
        },
        required: ["website"],
      },
    },
    {
      name: "start_trial",
      description: `Create their Belline account on the ${TRIAL.days}-day free trial (no card) and email them a sign-in link. Only after you have spelled the email address back and they confirmed it.`,
      input_schema: {
        type: "object",
        properties: {
          business_name: { type: "string" },
          email: { type: "string" },
          email_confirmed: { type: "boolean", description: "True only if they confirmed the spelling you read back." },
          vertical: { type: "string", enum: ["salon", "clinic", "restaurant"], description: "Closest match. Clinics, dental, physio, vets: clinic. Salons, spas, barbers, studios: salon." },
          website: { type: "string" },
          timezone: { type: "string", description: "IANA timezone; Asia/Dubai for the UAE." },
        },
        required: ["business_name", "email", "email_confirmed", "vertical"],
      },
    },
    {
      name: "send_checkout",
      description:
        "Email a link to pay for a plan, for somebody who has decided. Never take card details yourself.",
      input_schema: {
        type: "object",
        properties: {
          email: { type: "string" },
          plan: { type: "string", enum: sellable("AE").map((p) => p.id) },
          cycle: { type: "string", enum: ["monthly", "annual"] },
        },
        required: ["email", "plan"],
      },
    },
  ];
}

function channelOf(ctx: ToolContext): string {
  return ctx.call.channel === "phone" ? "phone" : ctx.call.channel === "webchat" ? "chat" : ctx.call.channel === "whatsapp" ? "whatsapp" : "voice";
}

const spoken = (ctx: ToolContext) => ctx.call.channel !== "webchat" && ctx.call.channel !== "whatsapp";

function flag(ctx: ToolContext, note: string) {
  ctx.call.escalation = ctx.call.escalation ? `${ctx.call.escalation} · ${note}` : note;
}

/** Runs a sales tool, or returns null when `name` is not one. */
export async function executeSalesTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome | null> {
  if (!ctx.location.internal) return null;
  switch (name) {
    case "record_lead":
      return { result: recordLead(input, ctx) };
    case "quote":
      return { result: quote(input, ctx) };
    case "build_demo":
      return { result: await buildDemo(input, ctx) };
    case "start_trial":
      return { result: await startTrial(input, ctx) };
    case "send_checkout":
      return { result: await sendCheckout(input) };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------

function recordLead(input: Record<string, unknown>, ctx: ToolContext) {
  const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
  const email = str(input.email, 254);
  const rawPhone = str(input.phone, 40) || ctx.callerNumber || "";
  const { phone, valid } = normalisePhone(rawPhone);
  const business = str(input.business, 120);
  if (!business) return { saved: false, say: "Ask which business this is for." };

  const lead: Lead = {
    id: id("lead"),
    createdAt: new Date().toISOString(),
    name: str(input.name, 120) || "Unknown",
    email,
    phone,
    phoneValid: valid,
    company: business,
    website: str(input.website, 200) || undefined,
    intent: str(input.stage, 40) || undefined,
    vertical: str(input.vertical, 60) || undefined,
    venues: str(input.venues, 40) || undefined,
    notes: str(input.pain, 800) || undefined,
    source: `belle:${channelOf(ctx)}`,
    emailCheck: checkShape(email),
    status: "new",
  };

  // One row per prospect: a second call to this tool updates the first.
  const previous = email ? findRecentDuplicate(listLeads(), lead) : undefined;
  saveLead(previous ? { ...previous, ...Object.fromEntries(Object.entries(lead).filter(([, v]) => v)), id: previous.id, createdAt: previous.createdAt } as Lead : lead);
  if (input.stage === "wants_person") flag(ctx, `Wants a person: ${business}`);
  return { saved: true };
}

function quote(input: Record<string, unknown>, ctx: ToolContext) {
  const asks = String(input.asks_for ?? "none");
  const plans = sellable("AE").map((p) => ({
    plan: p.id,
    name: p.name,
    price: `${money(priceOf(p.id, "AE"), "AE")} a month`,
    annual: `${money(periodFee([p.id], "AE", "annual"), "AE")} billed yearly (${money(annualPerMonth([p.id], "AE"), "AE")} a month)`,
    includes: publicLines(p),
    most_popular: Boolean(p.recommended),
  }));
  const base = {
    plans,
    trial: `${TRIAL.days} days free, ${TRIAL.minutes} voice minutes and ${TRIAL.conversations} text conversations, every channel on, no card`,
    always: "Priced per location. Setting up is free. Cancel any time.",
  };

  if (asks === "discount" || asks === "contract" || asks === "guarantee") {
    flag(ctx, `Asked about ${asks} — list prices only were given`);
    return {
      ...base,
      refused: asks,
      say:
        asks === "discount"
          ? "Say plainly that the prices are the same for everyone and you cannot change them, that paying yearly is two months free, and that the trial costs nothing. Offer to have a person get back to them if price is the only thing in the way."
          : "Say there are no contracts to sign and no guarantees you can promise beyond what the plans include — it is monthly, cancel any time. Offer a person if they need it in writing.",
    };
  }
  if (asks === "several_venues") {
    flag(ctx, "Group with several venues — wants pricing");
    return {
      ...base,
      say: "Give the per-venue prices, then say groups are priced properly by a person and offer to set that up. Record the lead with stage wants_person.",
    };
  }
  return {
    ...base,
    say: spoken(ctx)
      ? "Say the three plans briefly in words — name, price, phone minutes — mention the most popular one, then ask which fits their volume. Do not read every feature."
      : "Give the three plans in a short list with price and what each includes at a glance, mark the most popular, then ask a question about their volume.",
  };
}

async function buildDemo(input: Record<string, unknown>, ctx: ToolContext) {
  const count = demosBuilt.get(ctx.call.id) ?? 0;
  if (count >= DEMOS_PER_CONVERSATION) {
    return { built: false, say: "Say you have already built the demo in this conversation and point them to that link." };
  }
  const website = String(input.website ?? "").trim();
  if (!website) return { built: false, say: "Ask for their website address." };

  let location;
  try {
    location = await createProspectDemo(website);
  } catch (err) {
    return {
      built: false,
      reason: err instanceof Error ? err.message : String(err),
      say: "Say you could not read that website, and offer to start their trial instead — setup works from answers as well as from a site.",
    };
  }
  demosBuilt.set(ctx.call.id, count + 1);
  const url = `${appOrigin()}/demo/${location.prospect!.slug}`;

  const sent: string[] = [];
  const to = String(input.send_to_email ?? "").trim();
  if (to && checkShape(to).valid) {
    const mail = await sendEmail({
      to,
      subject: `Your Belline demo — ${location.name}`,
      text: `Here is ${location.name} with Belline answering: ${url}\n\nChat with it or call it, and try to catch it out. It was built from your public website, so some details may be off, and nothing booked there is real.\n\nWhen you are ready, the ${TRIAL.days}-day trial is free with no card.\n\nBelle, Belline`,
      html: `<p>Here is <strong>${escapeHtml(location.name)}</strong> with Belline answering:</p><p><a href="${url}">${url}</a></p><p>Chat with it or call it, and try to catch it out. It was built from your public website, so some details may be off, and nothing booked there is real.</p><p>When you are ready, the ${TRIAL.days}-day trial is free with no card.</p><p>Belle, Belline</p>`,
      replyTo: HELLO,
    });
    if (mail.sent) sent.push("email");
  } else if (spoken(ctx) && ctx.callerNumber && smsEnabled()) {
    const sms = await sendSms(ctx.callerNumber, `Your Belline demo for ${location.name}: ${url}`);
    if (sms.sent) sent.push("text");
  }

  return {
    built: true,
    name: location.name,
    url: spoken(ctx) ? undefined : url,
    sent,
    say: spoken(ctx)
      ? sent.length
        ? `Tell them the demo of ${location.name} is on its way by ${sent.join(" and ")}, and that they can chat with it or ring it.`
        : "Say the demo is built and ask for an email address to send it to, reading it back before you call build_demo again with send_to_email."
      : `Share the link to ${location.name}'s demo and invite them to chat with it now, then ask what they thought.`,
  };
}

async function startTrial(input: Record<string, unknown>, ctx: ToolContext) {
  if (input.email_confirmed !== true) {
    return { started: false, say: "Spell the email address back letter by letter and get a yes before starting the trial." };
  }
  const shape = checkShape(String(input.email ?? ""));
  if (!shape.valid || !shape.email) {
    return { started: false, say: shape.suggestion ? `Ask whether they meant ${shape.suggestion}.` : "Say that address does not look right and ask for it again." };
  }
  if (findUserByEmail(shape.email)) {
    return { started: false, say: "Say that email already has a Belline account, and they can sign in at app.belline.ai — or use a different address." };
  }

  const vertical = (["salon", "clinic", "restaurant"].includes(String(input.vertical)) ? input.vertical : "salon") as Vertical;
  const signed = await signUp({
    businessName: String(input.business_name ?? ""),
    email: shape.email,
    password: `${crypto.randomBytes(18).toString("base64url")}Aa1!`,
    vertical,
    timezone: String(input.timezone ?? "") || "Asia/Dubai",
  });
  if (!signed.ok) return { started: false, say: `Say this could not be set up: ${signed.error}` };

  const link = `${appOrigin()}/api/auth/magic?t=${encodeURIComponent(signLoginToken(signed.user))}`;
  const website = String(input.website ?? "").trim();
  const mail = await sendEmail({
    to: shape.email,
    subject: `Your Belline trial for ${signed.location.name} is ready`,
    text: `Your ${TRIAL.days}-day trial has started — no card, nothing charged.\n\nSign in here (the link works once, for 24 hours): ${link}\n\nPaste your website and Belline sets itself up from it; it asks only about what the site does not say.\n\nBelle, Belline`,
    html: `<p>Your ${TRIAL.days}-day trial has started — no card, nothing charged.</p><p><a href="${link}">Sign in and set up ${escapeHtml(signed.location.name)}</a><br><small>The link works once, for 24 hours.</small></p><p>Paste your website and Belline sets itself up from it; it asks only about what the site does not say.</p><p>Belle, Belline</p>`,
    replyTo: HELLO,
  });
  await sendEmail({
    to: HELLO,
    subject: `Trial started by Belle: ${signed.location.name}`,
    text: `Business: ${signed.location.name}\nEmail: ${shape.email}\nVertical: ${vertical}\nWebsite: ${website || "—"}\nChannel: ${channelOf(ctx)}\nCaller: ${ctx.callerNumber ?? "—"}\nCall: ${ctx.call.id}`,
    html: `<p>Belle started a trial.</p><ul><li>${escapeHtml(signed.location.name)}</li><li>${escapeHtml(shape.email)}</li><li>${vertical}</li><li>${escapeHtml(website || "—")}</li><li>${channelOf(ctx)} · call ${ctx.call.id}</li></ul>`,
  });

  return {
    started: true,
    emailed: mail.sent,
    say: mail.sent
      ? "Tell them the trial is live and a sign-in link is in their inbox now — it works once, for a day. Suggest they open it and paste their website; setup takes minutes."
      : "Tell them the account is created and the team will email their sign-in link shortly. Do not read out any link.",
  };
}

async function sendCheckout(input: Record<string, unknown>) {
  const shape = checkShape(String(input.email ?? ""));
  if (!shape.valid || !shape.email) return { sent: false, say: "Ask for an email address to send the link to, and read it back." };
  const selection = checkSelection([input.plan], "AE");
  if (!selection.ok) return { sent: false, say: "Call quote and ask which of the three plans they want." };
  const planId = selection.products[0] as ProductId;
  const annual = input.cycle === "annual";
  const url = `${appOrigin()}/checkout?products=${planId}${annual ? "&cycle=annual" : ""}`;
  const mail = await sendEmail({
    to: shape.email,
    subject: "Your Belline plan",
    text: `Here is the link to choose your plan and pay securely by card: ${url}\n\nSetting up is free, and you can cancel any time.\n\nBelle, Belline`,
    html: `<p><a href="${url}">Choose your plan and pay securely</a></p><p>Setting up is free, and you can cancel any time.</p><p>Belle, Belline</p>`,
    replyTo: HELLO,
  });
  return {
    sent: mail.sent,
    say: mail.sent
      ? "Tell them the checkout link is in their inbox, card details go straight to Stripe, and they can start today."
      : "Say the link could not be emailed right now and the team will send it shortly.",
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
