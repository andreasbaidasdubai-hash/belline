import type { Call, Location, ToolTrace } from "../types";
import type { AgentEvent } from "../agent/runtime";
import { executeTool, toolsFor } from "../agent/tools";
import { assertStubsSafe } from "../flags";

/**
 * A scripted receptionist for the mock video provider, local runs only.
 *
 * The real turn needs a model key; a stubbed run has none, and the point of
 * the mock is to prove the plumbing — the model route, the stream, the tools,
 * the call record, the lead in the store — end to end. So this answers from a
 * few phrases and, where one asks for it, runs the **real** tool through
 * `executeTool`, exactly as the model would have. What it proves is that a
 * booking request or a lead taken on a video call lands where every other
 * channel's does; what it cannot prove is how well the model talks, which is
 * the owner test script's job on staging.
 *
 * Refuses to exist where the stubs are refused.
 */

export interface VideoAgent {
  readonly call: Call;
  respond(text: string): AsyncGenerator<AgentEvent>;
}

function grab(pattern: RegExp, text: string): string {
  return pattern.exec(text)?.[1]?.trim() ?? "";
}

export function stubVideoAgent(location: Location, call: Call): VideoAgent {
  assertStubsSafe();
  const tools = new Set(toolsFor(location, "video").map((t) => t.name));

  async function* run(name: string, input: Record<string, unknown>): AsyncGenerator<AgentEvent, unknown> {
    const t0 = Date.now();
    const outcome = await executeTool(name, input, { location, call, liveTransfer: false });
    const trace: ToolTrace = { at: new Date().toISOString(), name, input, output: outcome.result, ms: Date.now() - t0, ok: true };
    call.toolCalls.push(trace);
    yield { type: "tool", trace };
    return outcome;
  }

  return {
    call,
    async *respond(text: string) {
      const lower = text.toLowerCase();
      const name = grab(/(?:[Mm]y name is|I'm|I am|[Tt]his is)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/, text) || "Visitor";
      const phone = grab(/(\+?\d[\d\s-]{6,}\d)/, text);
      const email = grab(/([\w.+-]+@[\w-]+\.[\w.]+)/, text);
      const said: string[] = [];
      const say = (line: string): AgentEvent => {
        said.push(line);
        return { type: "sentence", text: line };
      };

      if (/\b(bye|goodbye|that's all|thank you, bye)\b/.test(lower) && tools.has("end_call")) {
        yield say("Thanks for stopping by. Goodbye!");
        yield* run("end_call", { summary: "Visitor said goodbye.", outcome: "answered_question" });
        yield { type: "control", action: "end_call", detail: "Visitor said goodbye." };
      } else if (/\b(business|salon|clinic|restaurant)\b.*\bcalled\b/.test(lower) && tools.has("record_lead")) {
        const business = grab(/called\s+([A-Za-z0-9' &]+?)(?:[.,]|\s+and\b|$)/i, text) || "Their business";
        yield* run("record_lead", { name, business, email, phone, stage: "interested" });
        yield say(`Thanks, ${name}. I've noted ${business} and someone from the team will be in touch.`);
      } else if (/\b(book|table|appointment|reservation)\b/.test(lower) && tools.has("take_booking_request") && phone) {
        yield* run("take_booking_request", { guest_name: name, guest_phone: phone, preferred: text.slice(0, 120) });
        yield say("Thank you. Your request is with the team, and they'll get back to you to confirm.");
      } else if (/\b(person|human|someone|message|call me back)\b/.test(lower) && tools.has("take_message")) {
        yield* run("take_message", { caller_name: name, callback_number: phone, message: text.slice(0, 300), urgency: "normal" });
        yield say("I've passed that to the team, and someone will get back to you shortly.");
      } else if (/\b(are you (a )?(person|human|real|robot|ai))\b/.test(lower)) {
        yield say(`I'm ${location.agent.displayName}, the AI assistant for ${location.name}.`);
        yield say("How can I help?");
      } else {
        yield say(`This is the mock receptionist for ${location.name}.`);
        yield say("Ask me to take a message, or tell me about your business.");
      }
      yield { type: "turn_end", text: said.join(" "), firstAudioMs: 0 };
    },
  };
}
