import type Anthropic from "@anthropic-ai/sdk";

/**
 * A scripted stand-in for Ask Belle's model, for local stubbed runs only
 * (FLAG_STUBS, which refuses to turn on in production or next to a real
 * database). It never calls anything: it reads the account block the real
 * prompt carries and answers a plan, trial or usage question from it with a
 * button to Billing and usage, so the dashboard's support mode can be seen
 * working end to end without a model key.
 */

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown };

function lastUserText(messages: Anthropic.MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

function accountLine(system: string, label: string): string {
  const block = system.split("# This owner's account (their data only)\n")[1]?.split("\n\n")[0] ?? "";
  return block.split("\n").find((l) => l.startsWith(`${label}:`))?.slice(label.length + 1).trim() ?? "";
}

export async function stubSupportModel(params: Anthropic.MessageCreateParamsNonStreaming): Promise<{ content: Block[] }> {
  const system = typeof params.system === "string" ? params.system : "";
  const messages = params.messages;
  const last = messages.at(-1);
  const afterTool = Array.isArray(last?.content) && last.content.some((c) => (c as { type?: string }).type === "tool_result");
  const asked = lastUserText(messages);

  if (/trial|plan|days|usage|minutes|conversations|account|bill/i.test(asked)) {
    if (!afterTool) {
      return { content: [{ type: "tool_use", id: `toolu_stub_${Date.now()}`, name: "link_to_page", input: { href: "/billing" } }] };
    }
    const plan = accountLine(system, "Plan");
    const usage = accountLine(system, "Usage this period").replace(/^\([^)]*\):\s*/, "");
    return {
      content: [
        {
          type: "text",
          text: plan
            ? `${plan.replace(/^free trial/, "You're on the free trial")}${usage ? ` So far this period: ${usage}` : ""} Billing and usage has the details.`
            : "I can't see a plan on your account yet. Billing and usage is where you choose one.",
        },
      ],
    };
  }
  return { content: [{ type: "text", text: "This is a local test run, so I can only answer questions about your plan and usage here." }] };
}
