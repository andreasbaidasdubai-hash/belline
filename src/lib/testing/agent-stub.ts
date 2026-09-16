import { randomUUID } from "node:crypto";
import type { Location } from "../types";
import type { AgentModel } from "../onboarding/selftest";
import { takesRequestsOnly } from "../booking/destination";
import { keyTokens } from "../onboarding/selftest";

/**
 * A receptionist that follows the rules, for stubbed local runs only.
 *
 * Loaded by selftest.ts when FLAG_STUBS=on, which installStubs() refuses in
 * production and next to a real database. It lets the end-to-end journey reach
 * Go live on a machine with no model key, answering from the venue's own data
 * the way the prompt tells the real model to. It proves the plumbing, not the
 * model: check:selftest grades scripted wrong answers as well.
 */

type Params = Parameters<AgentModel>[0];

const text = (t: string) => ({ content: [{ type: "text", text: t }] });
const tool = (name: string, input: unknown) => ({ content: [{ type: "tool_use", id: `toolu_stub_${randomUUID()}`, name, input }] });

function lastUserText(params: Params): string {
  for (let i = params.messages.length - 1; i >= 0; i--) {
    const m = params.messages[i];
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

/** The name of the tool the previous assistant turn asked for, when this call carries its result. */
function answeredTool(params: Params): string | null {
  const last = params.messages[params.messages.length - 1];
  if (last?.role !== "user" || typeof last.content === "string") return null;
  const prior = params.messages[params.messages.length - 2];
  if (!prior || typeof prior.content === "string") return null;
  const use = (prior.content as { type: string; name?: string }[]).find((b) => b.type === "tool_use");
  return use?.name ?? null;
}

export function stubAgentModel(location: Location): AgentModel {
  return async (params) => {
    const done = answeredTool(params);
    if (done === "take_booking_request") return text("Thank you. Your request is with the team, and they'll get back to you to confirm.");
    if (done === "request_human_handoff" || done === "take_message") {
      return text("I've passed this to the team, and someone will get back to you shortly.");
    }
    if (done) return text("Thank you, that's noted.");

    const said = lastUserText(params);
    const lower = said.toLowerCase();

    if (/\p{Script=Arabic}/u.test(said)) return text("أهلاً بك! يسعدنا مساعدتك. من فضلك أخبرني بالوقت الذي يناسبك.");
    if (/card number/.test(lower)) return text("Please don't share card details here. I can't take payments in a message, and the team will arrange it safely.");
    if (/chest pain|dizzy/.test(lower)) return text("Please call emergency services on 998 straight away. I can't give medical advice here.");
    if (/manager|urgent/.test(lower)) {
      return tool("request_human_handoff", { reason: "asked for the manager", summary: "The customer asked urgently for the manager.", urgency: "urgent" });
    }
    if (/cancel/.test(lower)) {
      return tool("take_message", { caller_name: "Sam Taylor", callback_number: "050 123 4567", message: "Wants to cancel a booking.", urgency: "normal" });
    }
    if (/\bbook\b/.test(lower)) {
      const time = said.match(/\b(\d{1,2}:\d{2})\b/)?.[1];
      if (takesRequestsOnly(location)) {
        // What they asked for, the way the prompt tells the model to capture it.
        const what = said.match(/\bbook (?:an? )?(.+?) (?:tomorrow|today|on|at)\b/i)?.[1];
        return tool("take_booking_request", {
          guest_name: "Sam Taylor",
          guest_phone: "050 123 4567",
          preferred: said.slice(0, 120),
          time,
          ...(location.vertical === "restaurant" ? { party_size: 2 } : { service: what ?? "an appointment" }),
        });
      }
      return tool("check_availability", { date: new Date().toISOString().slice(0, 10), time, party_size: 2 });
    }
    if (/are you open/.test(lower)) return text("Sorry, we're closed then. I'd be happy to help you find another time.");

    // A saved question, answered with the saved answer.
    const asked = new Set(keyTokens(said));
    const faq = location.agent.faqs
      .map((f) => ({ f, score: keyTokens(f.q).filter((t) => asked.has(t)).length }))
      .sort((a, b) => b.score - a.score)[0];
    if (faq && faq.score > 0) return text(faq.f.a);

    return text("I don't have that information, but I can take a message and the team will find out for you.");
  };
}
