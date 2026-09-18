import { flag as isFlagOn, type FlagName } from "../../flags";
import {
  buildOpening,
  checkOpening,
  outcomesOf,
  prospectBriefing,
  prospectFactsFrom,
  topicsOf,
  type OpeningCheck,
  type ProspectFacts,
} from "./context";
import {
  demoStatus,
  demoStore,
  emptyStats,
  isHot,
  utcDay,
  type DemoEventName,
  type DemoStatus,
  type VideoDemoLink,
} from "./store";
import { demoLinkTtlDays, demoLinkUrl, newDemoLinkId, signDemoLinkToken, verifyDemoLinkToken } from "./token";
import { resolvePublicOrigin } from "../outreach/templates";
import { TAVUS_BUSINESS_PER_MIN_USD } from "../../billing/cost";
import { buildVideoDemoEmail, type EmailDraft } from "./email";
import { recordLeadEvent } from "../../staff/leads";

/**
 * Personalised video demos, end to end: preview, create, resolve, count,
 * revoke. Routes are thin; every rule is here, where the checks can reach it.
 */

type Env = Record<string, string | undefined>;

export interface DemoLimits {
  videoSessionsPerDay: number;
  chatsPerDay: number;
  messagesPerChat: number;
  /** Page views a minute per link before the page answers 429. */
  pageViewsPerMinute: number;
}

function intEnv(env: Env, key: string, fallback: number, max: number): number {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.floor(n)) : fallback;
}

export function demoLimits(env: Env = process.env): DemoLimits {
  return {
    videoSessionsPerDay: intEnv(env, "VIDEO_DEMO_SESSIONS_PER_DAY", 3, 20),
    chatsPerDay: intEnv(env, "VIDEO_DEMO_CHATS_PER_DAY", 5, 50),
    messagesPerChat: intEnv(env, "VIDEO_DEMO_MESSAGES_PER_CHAT", 20, 60),
    pageViewsPerMinute: intEnv(env, "VIDEO_DEMO_PAGE_VIEWS_PER_MINUTE", 30, 300),
  };
}

/**
 * The origin demo links point at. `PUBLIC_ORIGIN` wherever it is set, with the
 * outreach rules (never the marketing site); a local run without it falls back
 * to the origin the console was opened on.
 */
export function demoOrigin(requestOrigin: string | null, env: Env = process.env): string {
  if ((env.PUBLIC_ORIGIN ?? "").trim()) return resolvePublicOrigin(env);
  if (env.NODE_ENV === "production") return resolvePublicOrigin(env); // throws with the reason
  return (requestOrigin ?? "http://localhost:3000").replace(/\/+$/, "");
}

const flagOn = (name: string) => isFlagOn(name as FlagName);

// ---------------------------------------------------------------------------
// Staff: preview, create, revoke
// ---------------------------------------------------------------------------

export type PreviewResult =
  | { ok: true; facts: ProspectFacts; opening: string; check: OpeningCheck; briefing: string }
  | { ok: false; status: number; error: string };

export async function previewVideoDemo(leadId: number, opening?: string): Promise<PreviewResult> {
  const source = await demoStore().loadSource(leadId);
  if (!source) return { ok: false, status: 404, error: "No such lead." };
  if (!source.research) {
    return { ok: false, status: 409, error: "This lead has not been researched yet, so Belle would have nothing true to say about it." };
  }
  const facts = prospectFactsFrom(source);
  const text = (opening ?? buildOpening(facts)).replace(/\s+/g, " ").trim();
  return { ok: true, facts, opening: text, check: checkOpening(text, facts, flagOn), briefing: prospectBriefing(facts, text) };
}

export type CreateResult =
  | { ok: true; link: VideoDemoLink; token: string; url: string }
  | { ok: false; status: number; error: string; problems?: string[] };

export async function createVideoDemo(input: {
  leadId: number;
  opening?: string;
  ttlDays?: number;
  actor: string;
  origin: string;
  env?: Env;
  now?: number;
}): Promise<CreateResult> {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now();
  const preview = await previewVideoDemo(input.leadId, input.opening);
  if (!preview.ok) return preview;
  if (preview.check.problems.length > 0) {
    return { ok: false, status: 422, error: "The opening needs changing before Belle can say it.", problems: preview.check.problems };
  }
  const id = newDemoLinkId();
  const expiresAt = now + demoLinkTtlDays(env, input.ttlDays) * 86_400_000;
  const link: VideoDemoLink = {
    id,
    leadId: preview.facts.leadId,
    companyId: preview.facts.companyId,
    facts: preview.facts,
    opening: preview.opening,
    createdBy: input.actor,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    stats: emptyStats(),
    daily: {},
  };
  const store = demoStore();
  await store.insert(link);
  await store.log({
    leadId: link.leadId,
    companyId: link.companyId,
    actor: input.actor,
    type: "demo_issued",
    summary: `Video demo link created for ${link.facts.businessName}`,
    data: { videoDemo: link.id, event: "link_created" satisfies DemoEventName, expiresAt: link.expiresAt, words: preview.check.words },
  });
  const token = signDemoLinkToken(id, expiresAt, env);
  return { ok: true, link, token, url: demoLinkUrl(input.origin, token) };
}

export async function revokeVideoDemo(id: string, actor: string): Promise<VideoDemoLink | null> {
  const store = demoStore();
  const at = new Date().toISOString();
  const revoked = await store.update(id, (link) => (link.revokedAt ? null : { ...link, revokedAt: at, revokedBy: actor }));
  if (revoked) {
    await store.log({
      leadId: revoked.leadId,
      companyId: revoked.companyId,
      actor,
      type: "demo_issued",
      summary: `Video demo link revoked for ${revoked.facts.businessName}`,
      data: { videoDemo: id, event: "revoked" satisfies DemoEventName },
    });
  }
  return revoked;
}

export interface LinkView {
  id: string;
  leadId: number;
  businessName: string;
  status: DemoStatus;
  hot: boolean;
  url: string;
  thumbnailUrl: string;
  opening: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  revokedAt?: string;
  stats: VideoDemoLink["stats"];
}

/** The token is not stored: it is signed again from the id and the expiry. */
export function linkView(link: VideoDemoLink, origin: string, env: Env = process.env): LinkView {
  const token = signDemoLinkToken(link.id, Date.parse(link.expiresAt), env);
  return {
    id: link.id,
    leadId: link.leadId,
    businessName: link.facts.businessName,
    status: demoStatus(link),
    hot: isHot(link.stats),
    url: demoLinkUrl(origin, token),
    thumbnailUrl: `${origin}/api/video-demo/${token}/thumbnail`,
    opening: link.opening,
    createdAt: link.createdAt,
    createdBy: link.createdBy,
    expiresAt: link.expiresAt,
    ...(link.revokedAt ? { revokedAt: link.revokedAt } : {}),
    stats: link.stats,
  };
}

/**
 * The email draft for a link. Reads the suppression list and the lead's touch
 * spacing now, not when the link was made: an opt-out can arrive in between.
 * Writes nothing and sends nothing.
 */
export async function draftForLink(id: string, origin: string, env: Env = process.env): Promise<EmailDraft | null> {
  const store = demoStore();
  const link = await store.get(id);
  if (!link) return null;
  const view = linkView(link, origin, env);
  const [suppressed, policy] = await Promise.all([
    store.suppressed({ email: link.facts.contactEmail, domain: link.facts.domain, companyId: link.companyId }),
    store.touchPolicy(link.leadId),
  ]);
  return buildVideoDemoEmail({
    facts: link.facts,
    demoUrl: view.url,
    thumbnailUrl: view.thumbnailUrl,
    linkActive: view.status === "active",
    suppressed,
    policy,
    flagOn,
  });
}

// ---------------------------------------------------------------------------
// Public: the token, the limits, the tracking
// ---------------------------------------------------------------------------

export type Resolved = { ok: true; link: VideoDemoLink; token: string } | { ok: false; reason: "invalid" | "not_found" | "expired" | "revoked" };

/** A token to a live link, or why not. The record is always read: that is what makes revoking work. */
export async function resolveDemoToken(token: unknown, env: Env = process.env, now = Date.now()): Promise<Resolved> {
  const claim = verifyDemoLinkToken(token, env, now);
  if (!claim) {
    // An expired but genuine token says "expired", not "invalid": the page can be kind about it.
    const expired = verifyDemoLinkToken(token, env, 0);
    return { ok: false, reason: expired ? "expired" : "invalid" };
  }
  const link = await demoStore().get(claim.linkId);
  if (!link) return { ok: false, reason: "not_found" };
  // The token's expiry and the record's must agree; a record can only shorten it.
  const status = demoStatus(link, now);
  if (status !== "active") return { ok: false, reason: status };
  if (Math.floor(Date.parse(link.expiresAt)) !== claim.expiresAt) return { ok: false, reason: "invalid" };
  return { ok: true, link, token: token as string };
}

/** The server-side context a session on this link carries. Never from the visitor. */
export function sessionContextFor(link: VideoDemoLink): { briefing: string; greeting: string } {
  return { briefing: prospectBriefing(link.facts, link.opening), greeting: link.opening };
}

const pageHits = new Map<string, number[]>();

/** A sliding one-minute window per link, in this process. */
export function pageViewAllowed(linkId: string, env: Env = process.env, now = Date.now()): boolean {
  const max = demoLimits(env).pageViewsPerMinute;
  const recent = (pageHits.get(linkId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= max) {
    pageHits.set(linkId, recent);
    return false;
  }
  recent.push(now);
  pageHits.set(linkId, recent);
  if (pageHits.size > 5000) pageHits.clear();
  return true;
}

function bumpDay(link: VideoDemoLink, key: "video" | "chats" | "opens", now: number) {
  const day = utcDay(now);
  // Only today and yesterday are ever read; older days are dropped as they pass.
  const kept = Object.fromEntries(Object.entries(link.daily).filter(([d]) => d >= utcDay(now - 86_400_000)));
  const today = kept[day] ?? { video: 0, chats: 0, opens: 0 };
  return { ...kept, [day]: { ...today, [key]: today[key] + 1 } };
}

/** Take one of today's video sessions for this link, or refuse. */
export async function reserveVideoSession(linkId: string, env: Env = process.env, now = Date.now()): Promise<boolean> {
  const max = demoLimits(env).videoSessionsPerDay;
  const out = await demoStore().update(linkId, (link) => {
    if ((link.daily[utcDay(now)]?.video ?? 0) >= max) return null;
    return { ...link, daily: bumpDay(link, "video", now) };
  });
  return Boolean(out);
}

/** Give a reserved session back: the provider refused, so nothing was used. */
export async function releaseVideoSession(linkId: string, now = Date.now()): Promise<void> {
  await demoStore().update(linkId, (link) => {
    const day = utcDay(now);
    const today = link.daily[day];
    if (!today || today.video <= 0) return null;
    return { ...link, daily: { ...link.daily, [day]: { ...today, video: today.video - 1 } } };
  });
}

export async function reserveChat(linkId: string, env: Env = process.env, now = Date.now()): Promise<boolean> {
  const max = demoLimits(env).chatsPerDay;
  const out = await demoStore().update(linkId, (link) => {
    if ((link.daily[utcDay(now)]?.chats ?? 0) >= max) return null;
    return { ...link, daily: bumpDay(link, "chats", now), stats: { ...link.stats, chats: link.stats.chats + 1 } };
  });
  return Boolean(out);
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

/**
 * Something happened on a link. Counters on the link, one row on the lead's
 * timeline. Topics and counts only: never what anybody said.
 */
export async function recordDemoEvent(
  linkId: string,
  event: DemoEventName,
  detail: {
    seconds?: number;
    provider?: string;
    callerLines?: string[];
    toolCalls?: { name: string; ok?: boolean; input?: Record<string, unknown> }[];
    messages?: number;
    actor?: string;
  } = {},
  now = Date.now(),
): Promise<VideoDemoLink | null> {
  const store = demoStore();
  const at = new Date(now).toISOString();
  const { topics, questions } = topicsOf(detail.callerLines ?? []);
  const outcomes = outcomesOf(detail.toolCalls ?? []);
  const seconds = Math.max(0, Math.round(detail.seconds ?? 0));
  const cost = detail.provider === "tavus" ? (seconds / 60) * TAVUS_BUSINESS_PER_MIN_USD : 0;
  let wasHot = false;

  const updated = await store.update(linkId, (link) => {
    wasHot = isHot(link.stats);
    const s = { ...link.stats };
    let daily = link.daily;
    switch (event) {
      case "opened":
        s.opens += 1;
        s.firstOpenedAt ??= at;
        s.lastOpenedAt = at;
        daily = bumpDay(link, "opens", now);
        break;
      case "video_started":
        s.videoSessions += 1;
        break;
      case "video_ended":
        s.videoSeconds += seconds;
        s.longestVideoSeconds = Math.max(s.longestVideoSeconds, seconds);
        s.costUsd = Math.round((s.costUsd + cost) * 10_000) / 10_000;
        break;
      case "chat_ended":
        s.chatMessages += detail.messages ?? 0;
        break;
      case "get_started_clicked":
        s.getStartedClicks += 1;
        break;
      case "email_prepared":
        s.emailPreparedAt = at;
        break;
      default:
        break;
    }
    s.questions += questions;
    s.topics = union(s.topics, topics);
    s.outcomes = union(s.outcomes, outcomes);
    return { ...link, stats: s, daily };
  });
  if (!updated) return null;
  const turnedHot = !wasHot && isHot(updated.stats);

  // The first open of the day is worth a row; the tenth is noise.
  const quietOpen = event === "opened" && (updated.daily[utcDay(now)]?.opens ?? 0) > 1;
  if (!quietOpen) {
    const name = updated.facts.businessName;
    const summary = {
      link_created: `Video demo link created for ${name}`,
      opened: `${name} opened their video demo`,
      video_started: `${name} started the video demo`,
      video_ended: `Video demo watched for ${seconds}s${questions ? `, ${questions} question${questions === 1 ? "" : "s"}` : ""}${outcomes.length ? ` (${outcomes.join(", ")})` : ""}`,
      chat_started: `${name} chose to chat with Belle instead`,
      chat_ended: `Demo chat: ${detail.messages ?? 0} messages${outcomes.length ? ` (${outcomes.join(", ")})` : ""}`,
      get_started_clicked: `${name} clicked Get started from the demo`,
      email_prepared: `Demo email opened in a mail app by staff`,
      revoked: `Video demo link revoked`,
    }[event];
    await store.log({
      leadId: updated.leadId,
      companyId: updated.companyId,
      actor: detail.actor ?? "system",
      type: event === "email_prepared" ? "demo_issued" : "demo_used",
      summary,
      data: {
        videoDemo: linkId,
        event,
        ...(seconds ? { seconds } : {}),
        ...(topics.length ? { topics } : {}),
        ...(questions ? { questions } : {}),
        ...(outcomes.length ? { outcomes } : {}),
        ...(cost ? { costUsd: Math.round(cost * 10_000) / 10_000 } : {}),
        ...(turnedHot ? { hot: true } : {}),
      },
    });
  }
  // A click into the demo ends the sequence. The cold email's entire job was
  // to earn that click; a follow-up afterwards asking whether they saw it is
  // a machine talking over somebody who is already listening. Best effort —
  // tracking must never fail a visitor's request — but the stop is also
  // re-checked by the gate before every send, so a failure here delays it by
  // one pass rather than losing it.
  if (event === "opened" || event === "video_started" || event === "chat_started") {
    try {
      const { demoOpened } = await import("../sending/replies");
      await demoOpened(updated.leadId);
    } catch (err) {
      console.error("[video-demo] could not stop the sequence:", err instanceof Error ? err.message : String(err));
    }
  }

  if (turnedHot) {
    // The staff console's hot mechanism: the lead list, Today and the lead
    // page read `demo_watched` from the lead's CRM events (lib/staff/leads.ts).
    // Tracking must never fail a visitor's request, so a failure is logged only.
    try {
      const s = updated.stats;
      recordLeadEvent(`db:${updated.leadId}`, {
        type: "demo_watched",
        summary: `${updated.facts.businessName} ${s.questions > 0 ? `asked Belle ${s.questions} question${s.questions === 1 ? "" : "s"}` : `watched the video demo for ${Math.max(s.longestVideoSeconds, s.videoSeconds)}s`}`,
        actor: "system",
        data: { videoDemo: linkId, seconds: s.videoSeconds, questions: s.questions },
      }, new Date(now));
    } catch (err) {
      console.error("[video-demo] could not mark the lead hot:", err instanceof Error ? err.message : String(err));
    }
  }
  return updated;
}
