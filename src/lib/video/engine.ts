import crypto from "node:crypto";
import type { Call, Location } from "../types";
import { getCall, getLocation, saveCall } from "../store";
import { AgentSession, type AgentEvent } from "../agent/runtime";
import { assessAuthority } from "../agent/authority";
import {
  checkRequestReply,
  checkSlotOffers,
  checkTimes,
  publishedTimes,
  repairReply,
  repairRequestReply,
  repairSlotOffers,
  timesIn,
} from "../agent/honesty";
import { takesRequestsOnly } from "../booking/destination";
import { answersIn, inHouseSpelling } from "../language";
import { toSpoken } from "../voice/spoken";
import { flag } from "../flags";
import { readVideoControl } from "./control";
import { recordVideoMetric } from "./metrics";
import { endVideoSession, getVideoSession, markVideoJoined, type VideoSession } from "./sessions";
import { stubVideoAgent, type VideoAgent } from "./stub-agent";
import { contentText, tokenFromSystemMessages, venuePalKey, verifyVideoToken } from "./tokens";
import { markSharedContextBroken } from "./shared-pal";
import { videoFastModel } from "./model-policy";

/**
 * Belline's receptionist, as the video provider's language model.
 *
 * Tavus calls this as an OpenAI-compatible `/chat/completions` endpoint and
 * speaks whatever streams back. Behind it is not a second agent but the same
 * one the bell and the telephone use — the same prompt (with a video medium
 * block), the same tools, the same booking engine and the same call record —
 * run in the order the voice session runs it:
 *
 *   1. **Who is asking.** The token names one session at one venue (tokens.ts).
 *      Anything else is refused before the body is trusted for anything.
 *   2. **The authority rules**, before the model: an emergency or a clinical
 *      question gets the venue's fixed words, never the model's.
 *   3. **The turn**, streamed a clause at a time as it is written.
 *   4. **The honesty guards, per clause**: an invented time or a claimed
 *      booking at a venue that confirms its own is repaired before it is
 *      spoken — on a phone it would already be in the caller's ear.
 *   5. **The spoken-language layer**, so prices, times and references are
 *      written the way the voice should say them.
 *
 * Tavus sends the whole conversation each time; Belline keeps its own (with the
 * tool calls in it) and takes only the newest thing the visitor said. A newer
 * request cuts off an older one still streaming, the way barge-in does on a
 * call.
 */

type Env = Record<string, string | undefined>;

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

/** Tools whose success means something was taken down for the business. */
const OUTCOME_TOOLS = new Set(["book", "take_booking_request", "take_message", "record_lead", "join_waitlist", "change_booking", "cancel_booking"]);

function openAiError(status: number, message: string, type = "invalid_request_error"): Response {
  return Response.json({ error: { message, type } }, { status, headers: { "cache-control": "no-store" } });
}

/** The credential Tavus sends. `api_key` on an OpenAI-compatible client is a Bearer token. */
function credentialOf(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  return bearer || req.headers.get("x-api-key")?.trim() || req.headers.get("api-key")?.trim() || "";
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Which venue's shared PAL a key belongs to, among the PALs Belline has made. */
function venueOfPalKey(credential: string, env: Env): string | null {
  for (const record of Object.keys(readVideoControl().pals)) {
    const [locationId, faceId] = record.split("|");
    if (locationId && faceId && sameSecret(credential, venuePalKey(locationId, faceId, env))) return locationId;
  }
  return null;
}

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return contentText(messages[i].content);
  }
  return "";
}

/** Resolve the request to one live session, or say why not. */
export function authoriseVideoLlm(
  req: Request,
  messages: ChatMessage[],
  env: Env = process.env,
): { ok: true; session: VideoSession; location: Location } | { ok: false; response: Response } {
  const credential = credentialOf(req);
  // Per-session PAL: the credential is the token.
  let claim = verifyVideoToken(credential, "llm", env);
  // A venue's shared PAL: the credential is that venue's derived key, and the
  // token comes from a system message — never from anything the visitor said.
  // Both must name the same venue, and the session's own face: a validly signed
  // token for another venue's session, arriving through this venue's PAL, is
  // refused exactly as a forged one is.
  if (!claim && credential.startsWith("bvk1_")) {
    const token = tokenFromSystemMessages(messages);
    const tokenClaim = verifyVideoToken(token, "llm", env);
    const target = tokenClaim ? getVideoSession(tokenClaim.sessionId) : undefined;
    if (
      tokenClaim &&
      target?.faceId &&
      target.locationId === tokenClaim.locationId &&
      sameSecret(credential, venuePalKey(tokenClaim.locationId, target.faceId, env))
    ) {
      claim = tokenClaim;
    } else if (!token) {
      // A real venue key with no token anywhere in the system messages: Tavus
      // did not put `conversational_context` where the shared mode needs it.
      const venue = venueOfPalKey(credential, env);
      if (venue) markSharedContextBroken(venue);
    }
  }
  if (!claim) return { ok: false, response: openAiError(401, "Not authorised.", "authentication_error") };

  const session = getVideoSession(claim.sessionId);
  // The token's venue must be the session's venue. A token is only ever minted
  // for its own session, so this failing means something was tampered with.
  if (!session || session.locationId !== claim.locationId) {
    return { ok: false, response: openAiError(403, "Not this conversation.", "permission_error") };
  }
  // "creating" counts: Tavus asks the model for its first turn while the create
  // call is still open, before this app has marked the session live. Refusing
  // that request (410) left Belle mute for the whole call — seen on staging,
  // 17 September 2026. Only an ended session is refused.
  if (session.status === "ended") {
    return { ok: false, response: openAiError(410, "This conversation has ended.") };
  }
  const location = getLocation(session.locationId);
  if (!location) return { ok: false, response: openAiError(410, "This conversation has ended.") };
  return { ok: true, session, location };
}

export async function handleChatCompletions(req: Request, env: Env = process.env): Promise<Response> {
  let body: { messages?: unknown; model?: unknown; stream?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return openAiError(400, "Send JSON.");
  }
  const messages = (Array.isArray(body.messages) ? body.messages : []) as ChatMessage[];
  const auth = authoriseVideoLlm(req, messages, env);
  if (!auth.ok) return auth.response;
  const { session, location } = auth;
  const model = typeof body.model === "string" ? body.model.slice(0, 60) : "belline-receptionist";
  const userText = lastUserText(messages).replace(/\s+/g, " ").trim().slice(0, 2000);
  // Shape only, never words: which roles arrived, how each carried its content,
  // and whether a caller line was found. Enough to see a format mismatch.
  console.log(
    `[video] ${session.id} model request: stream=${String(body.stream)} messages=${messages
      .map((m) => `${String(m?.role)}:${typeof m?.content === "string" ? `s${m.content.length}` : Array.isArray(m?.content) ? `a${m.content.length}` : typeof m?.content}`)
      .join(",")} caller=${userText.length}`,
  );

  // A model request means somebody is in the room and talking.
  markVideoJoined(session);

  // Anything still streaming belongs to the previous turn.
  if (session.turn) {
    session.turn.abort.abort();
    await session.turn.done.catch(() => undefined);
  }
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort());
  let settle!: () => void;
  const done = new Promise<void>((resolve) => (settle = resolve));
  session.turn = { abort, done };

  const id = `chatcmpl-${crypto.randomBytes(9).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  const frame = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  const run = (emit: (text: string) => void) =>
    runVideoTurn(session, location, userText, abort.signal, emit).finally(() => {
      if (session.turn?.done === done) session.turn = undefined;
      settle();
    });

  if (body.stream === false) {
    let text = "";
    await run((piece) => (text += piece));
    return Response.json(
      {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: text.trim() }, finish_reason: "stop" }],
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          abort.abort();
        }
      };
      send(frame({ role: "assistant", content: "" }, null));
      await run((piece) => send(frame({ content: piece }, null)));
      send(frame({}, "stop"));
      send("data: [DONE]\n\n");
      try {
        controller.close();
      } catch {
        /* already closed by the client going away */
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------

function agentFor(session: VideoSession, location: Location): VideoAgent {
  if (session.agent) return session.agent as VideoAgent;
  const call = getCall(session.callId);
  if (!call) throw new Error("The call record is missing.");
  // The scripted receptionist only with the mock provider under the stubs, which
  // are refused in production and next to a real database.
  const agent: VideoAgent =
    session.provider === "mock" && flag("stubs")
      ? stubVideoAgent(location, call)
      : new AgentSession(location, call, {
          channel: "video",
          greeting: session.greeting,
          liveTransfer: false,
          // Small talk on the fast model; any tool turn on the venue's (model-policy.ts).
          fastModel: videoFastModel(location),
          // A personalised demo's prospect context, written server-side from
          // the link's stored research when the session was created.
          briefing: session.demo?.briefing,
        });
  session.agent = agent;
  return agent;
}

/** Roughly how long a line takes to say, so an ending does not cut off the goodbye. */
function speakingMs(text: string): number {
  return Math.min(15_000, Math.max(3_000, text.length * 70));
}

/** The guards the written channels run on a whole reply, run here on each clause. */
export function guardVideoClause(location: Location, clause: string, call: Pick<Call, "toolCalls">, userText: string): string {
  const language = answersIn(location, { channel: "web_voice" });
  const requestsOnly = takesRequestsOnly(location);
  let out = clause;
  if (requestsOnly) {
    const offer = checkSlotOffers(out, language);
    if (!offer.ok) out = repairSlotOffers(out, offer, language);
  }
  const verdict = checkTimes(out, call.toolCalls, publishedTimes(location), new Set(timesIn(userText, language)), language);
  if (!verdict.ok) out = repairReply(out, verdict, { requestsOnly, language });
  if (requestsOnly) {
    const claim = checkRequestReply(out, language);
    if (!claim.ok) out = repairRequestReply(out, claim, language);
  }
  return toSpoken(inHouseSpelling(location, out, { channel: "web_voice" }), language).text;
}

/**
 * Write the turn down without undoing an ending that happened meanwhile.
 *
 * The session can be ended while the model is still talking — the visitor
 * closed the panel, the timer fired — and the call record closed. The turn's
 * words still belong in the transcript; its "active" status does not.
 */
function persist(agentCall: Call): void {
  const stored = getCall(agentCall.id);
  if (!stored || stored === agentCall || stored.status === "active") {
    saveCall(agentCall);
    return;
  }
  saveCall({
    ...stored,
    transcript: agentCall.transcript,
    toolCalls: agentCall.toolCalls,
    latenciesMs: agentCall.latenciesMs,
    escalation: stored.escalation ?? agentCall.escalation,
    bookingId: stored.bookingId ?? agentCall.bookingId,
    bookingRequests: agentCall.bookingRequests ?? stored.bookingRequests,
    authorityRuleId: stored.authorityRuleId ?? agentCall.authorityRuleId,
  });
}

export async function runVideoTurn(
  session: VideoSession,
  location: Location,
  userText: string,
  signal: AbortSignal,
  emit: (text: string) => void,
): Promise<void> {
  const startedAt = Date.now();

  // The kill switch reaches calls already in progress, politely.
  if (readVideoControl().killSwitch.on) {
    const bye = "I'm sorry, video calls have just been paused. Please use the chat instead. Goodbye.";
    emit(bye);
    setTimeout(() => void endVideoSession(session.id, "kill_switch", { by: "kill_switch" }), speakingMs(bye)).unref?.();
    return;
  }
  if (!userText) return;

  let agent: VideoAgent;
  try {
    agent = agentFor(session, location);
  } catch {
    emit("I'm sorry, something went wrong on our side. Please try the chat instead.");
    return;
  }
  const call = agent.call;
  call.transcript.push({ role: "caller", text: userText, at: new Date().toISOString() });

  const breach = assessAuthority(location, userText);
  if (breach) {
    const { rule } = breach;
    const said = rule.then === "transfer" && rule.sayIfNoTransfer ? rule.sayIfNoTransfer : rule.say;
    call.authorityRuleId = rule.id;
    call.escalation ??= rule.reason;
    emit(toSpoken(said, answersIn(location, { channel: "web_voice" })).text);
    call.transcript.push({ role: "agent", text: said, at: new Date().toISOString() });
    persist(call);
    setTimeout(() => void endVideoSession(session.id, "authority_rule", { by: "agent" }), speakingMs(said)).unref?.();
    return;
  }

  let spoken = "";
  let firstAt = -1;
  let endAfter: AgentEvent | null = null;
  const kinds: Record<string, number> = {};
  try {
    for await (const event of agent.respond(userText)) {
      kinds[event.type] = (kinds[event.type] ?? 0) + 1;
      if (signal.aborted) break;
      switch (event.type) {
        case "sentence": {
          const clause = guardVideoClause(location, event.text, call, userText);
          if (!clause) break;
          if (firstAt < 0) {
            firstAt = Date.now() - startedAt;
            call.latenciesMs.push(firstAt);
            recordVideoMetric(location, { name: "llm_first_token", sessionId: session.id, ms: firstAt });
          }
          spoken += (spoken ? " " : "") + clause;
          emit(`${clause} `);
          break;
        }
        case "tool":
          if (event.trace.ok && OUTCOME_TOOLS.has(event.trace.name)) {
            recordVideoMetric(location, { name: "booking_or_lead", sessionId: session.id, detail: event.trace.name });
          }
          break;
        case "control":
          endAfter = event;
          break;
        case "error":
          // The runtime follows an error with its own apology, which is spoken.
          console.warn(`[video] ${session.id} model error`);
          break;
        default:
          break;
      }
    }
  } catch (err) {
    console.warn(`[video] ${session.id} turn failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!spoken) {
      const sorry = "I'm sorry, I lost my train of thought. Could you say that again?";
      emit(sorry);
      spoken = sorry;
    }
  }

  if (spoken) call.transcript.push({ role: "agent", text: spoken, at: new Date().toISOString() });
  persist(call);
  // Counts only: whether this turn said anything, and why not if it didn't.
  console.log(
    `[video] ${session.id} turn: said=${spoken.length} chars first=${firstAt}ms total=${Date.now() - startedAt}ms aborted=${signal.aborted} events=${JSON.stringify(kinds)} call=${call.id}`,
  );

  if (endAfter && !signal.aborted) {
    setTimeout(() => void endVideoSession(session.id, "agent_ended", { by: "agent" }), speakingMs(spoken)).unref?.();
  }
}
