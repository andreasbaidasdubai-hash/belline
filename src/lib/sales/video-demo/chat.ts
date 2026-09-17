import type { Call, Location } from "../../types";
import { AgentSession } from "../../agent/runtime";
import { checkTimes, publishedTimes, repairReply, timesIn } from "../../agent/honesty";
import { startCall } from "../../calls";
import { getCall, saveCall } from "../../store";
import { recordDemoEvent, demoLimits, sessionContextFor } from "./service";
import type { VideoDemoLink } from "./store";

/**
 * "Prefer to type? Chat with Belle" on a demo page.
 *
 * The same sales Belle as the video call — Belline's own venue, its persona,
 * its policies, its tools — given the same server-written prospect briefing,
 * over the text channel. A conversation lives in this process for as long as
 * the page is open (half an hour idle at most), bounded by the link's chats a
 * day and the messages in one chat. The words go on the call record like any
 * other conversation on Belline's own line; the lead's timeline gets counts,
 * topics and outcomes only, when the chat goes quiet.
 */

interface DemoChat {
  key: string;
  linkId: string;
  callId: string;
  agent: AgentSession;
  messages: number;
  lastAt: number;
  callerLines: string[];
  reported: boolean;
}

const IDLE_MS = 30 * 60 * 1000;

const globalRef = globalThis as unknown as { __bellineDemoChats?: Map<string, DemoChat> };
function chats(): Map<string, DemoChat> {
  globalRef.__bellineDemoChats ??= new Map();
  return globalRef.__bellineDemoChats;
}

/** For the checks. */
export function clearDemoChats(): void {
  globalRef.__bellineDemoChats = new Map();
}

async function report(chat: DemoChat): Promise<void> {
  if (chat.reported) return;
  chat.reported = true;
  const call = getCall(chat.callId);
  await recordDemoEvent(chat.linkId, "chat_ended", {
    messages: chat.messages,
    callerLines: chat.callerLines,
    toolCalls: (call?.toolCalls ?? []).map((t) => ({ name: t.name, ok: t.ok, input: t.input as Record<string, unknown> })),
  });
  if (call && call.status === "active") {
    saveCall({ ...call, status: "completed", endedAt: new Date().toISOString(), outcome: call.outcome ?? "answered_question", summary: call.summary ?? "Chat on a personalised video demo page." });
  }
}

/** Close the chats nobody has typed in for a while, and tell the timeline. */
export async function sweepDemoChats(now = Date.now()): Promise<number> {
  let closed = 0;
  for (const [key, chat] of chats()) {
    if (now - chat.lastAt < IDLE_MS) continue;
    chats().delete(key);
    await report(chat).catch(() => undefined);
    closed++;
  }
  return closed;
}

export type ChatTurn =
  | { ok: true; reply: string; opening?: string; messagesLeft: number }
  | { ok: false; status: number; error: "chat_limit" | "message_limit" | "empty" };

export async function demoChatTurn(input: {
  link: VideoDemoLink;
  venue: Location;
  visitorId: string;
  chatId: string;
  text: string;
  reserve: () => Promise<boolean>;
  env?: Record<string, string | undefined>;
}): Promise<ChatTurn> {
  const text = input.text.replace(/\s+/g, " ").trim().slice(0, 1000);
  if (!text) return { ok: false, status: 400, error: "empty" };
  await sweepDemoChats();

  const limits = demoLimits(input.env);
  const key = `${input.link.id}:${input.visitorId}:${input.chatId}`;
  let chat = chats().get(key);
  let opening: string | undefined;
  if (!chat) {
    if (!(await input.reserve())) return { ok: false, status: 429, error: "chat_limit" };
    const call: Call = startCall(input.venue, "webchat", "demo-page");
    call.isDemo = true;
    saveCall(call);
    const context = sessionContextFor(input.link);
    opening = context.greeting;
    chat = {
      key,
      linkId: input.link.id,
      callId: call.id,
      agent: new AgentSession(input.venue, call, { channel: "text", briefing: context.briefing }),
      messages: 0,
      lastAt: Date.now(),
      callerLines: [],
      reported: false,
    };
    // The opening is Belle's first message, as it is the video's first words.
    call.transcript.push({ role: "agent", text: context.greeting, at: new Date().toISOString() });
    chats().set(key, chat);
    await recordDemoEvent(input.link.id, "chat_started");
  }
  if (chat.messages >= limits.messagesPerChat) return { ok: false, status: 429, error: "message_limit" };

  chat.messages++;
  chat.lastAt = Date.now();
  chat.callerLines.push(text);
  const call = chat.agent.call;
  call.transcript.push({ role: "caller", text, at: new Date().toISOString() });

  const sentences: string[] = [];
  try {
    for await (const event of chat.agent.respond(text)) {
      if (event.type === "sentence") sentences.push(event.text);
    }
  } catch (err) {
    console.warn(`[video-demo] chat turn failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let reply = sentences.join(" ").trim() || "Sorry, I lost my train of thought there. Could you ask me that again?";
  // Belle names no times on this line; a time she did not get from a tool is taken out.
  const verdict = checkTimes(reply, call.toolCalls, publishedTimes(input.venue), new Set(timesIn(text)));
  if (!verdict.ok) reply = repairReply(reply, verdict, { requestsOnly: true });

  call.transcript.push({ role: "agent", text: reply, at: new Date().toISOString() });
  saveCall(call);

  if (chat.messages >= limits.messagesPerChat) {
    chats().delete(key);
    await report(chat);
  }
  return { ok: true, reply, ...(opening ? { opening } : {}), messagesLeft: Math.max(0, limits.messagesPerChat - chat.messages) };
}
