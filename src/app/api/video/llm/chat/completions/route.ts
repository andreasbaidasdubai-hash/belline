import { handleChatCompletions } from "@/lib/video/engine";

export const dynamic = "force-dynamic";

/**
 * Belline's receptionist as the video provider's language model.
 *
 * OpenAI-compatible and streamed (SSE), because that is what Tavus's custom
 * LLM layer calls: the PAL's `base_url` is `<origin>/api/video/llm`, and Tavus
 * appends `/chat/completions`. Every request is tied to one session at one
 * venue by its token before anything else happens — see lib/video/engine.ts.
 */
export async function POST(req: Request) {
  return handleChatCompletions(req);
}
