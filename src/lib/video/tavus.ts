import { missingVideoConfig, type VideoConfig } from "./config";
import {
  VideoProviderError,
  type CreateSessionInput,
  type CreatedSession,
  type EndSessionInput,
  type VideoAvatarProvider,
  type VideoEvent,
  type WebhookVerdict,
} from "./types";

/**
 * Tavus Conversational Video Interface, as the face of Belline's receptionist.
 *
 * Every field below is from the docs as read on 17 September 2026; the
 * citations are in docs/video/tavus-notes.md, and nothing here is a guess at a
 * field that page does not list.
 *
 * **The model is Belline's.** Tavus is pointed at `/api/video/llm` as a custom
 * OpenAI-compatible LLM. The docs do not say that Tavus identifies the
 * conversation in those requests, and a conversation cannot override the PAL's
 * LLM settings — but they do recommend a PAL per session to vary the LLM
 * backend. So by default each session gets its own short-lived PAL whose
 * `api_key` is that session's token, and the PAL is deleted when the session
 * ends. A request that reaches the model route therefore names one venue and
 * one conversation using nothing but documented fields.
 *
 * `shared` mode (one PAL, token in `conversational_context`) is the lower
 * latency alternative for staging experiments; the model route refuses a
 * shared-mode request without a valid token in a system message.
 *
 * **What is never sent:** recordings are off, perception is off, the camera is
 * never asked for, and the context carries the business's and the agent's
 * names and nothing about the visitor.
 */

type Fetch = typeof fetch;

/** How long one call to Tavus may take before the visitor is told it failed. */
const TIMEOUT_MS = 15_000;

/** A template PAL's voice and turn-taking, fetched once and reused. */
const TEMPLATE_TTL_MS = 10 * 60 * 1000;

interface TemplatePal {
  at: number;
  palId: string;
  layers: Record<string, unknown>;
}

export class TavusProvider implements VideoAvatarProvider {
  readonly name = "tavus" as const;
  readonly capabilities = { perception: false, captions: true };
  private template: TemplatePal | null = null;
  private templateRefresh: Promise<unknown> | null = null;

  constructor(
    private readonly config: VideoConfig,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
  ) {}

  missingConfig(): string[] {
    return missingVideoConfig(this.config);
  }

  async createSession(input: CreateSessionInput): Promise<CreatedSession> {
    const faceId = input.faceId ?? this.config.tavus.faceId;
    const perSession = this.config.tavus.palMode === "per_session";
    let ephemeralPalId: string | undefined;

    if (perSession) {
      ephemeralPalId = await this.createPal(input, faceId);
    }

    try {
      const body = {
        face_id: faceId,
        pal_id: ephemeralPalId ?? input.palId ?? this.config.tavus.palId,
        // An id, not the venue: conversation names show in Tavus's dashboard.
        conversation_name: `belline-${input.sessionId}`,
        callback_url: input.callbackUrl,
        custom_greeting: input.greeting,
        conversational_context: this.context(input, perSession),
        // Private room: the browser needs the meeting token, which lives as
        // long as `participant_absent_timeout`.
        require_auth: true,
        ...(input.euPolicy ? { policy: "eu" } : {}),
        ...(this.config.tavus.testMode ? { test_mode: true } : {}),
        properties: {
          max_call_duration: input.maxCallSeconds,
          participant_left_timeout: input.leftTimeoutSeconds,
          participant_absent_timeout: input.absentTimeoutSeconds,
          enable_recording: false,
          enable_closed_captions: true,
          apply_greenscreen: false,
          languages: input.languages,
        },
      };
      const created = await this.call<{
        conversation_id?: string;
        conversation_url?: string;
        meeting_token?: string;
      }>("POST", "/v2/conversations", body);

      if (!created.conversation_id || !created.conversation_url) {
        throw new VideoProviderError("Tavus returned no conversation.", 502, true);
      }
      return {
        conversationId: created.conversation_id,
        roomUrl: created.conversation_url,
        meetingToken: created.meeting_token,
        ephemeralPalId,
      };
    } catch (err) {
      // Never leave a PAL behind for a conversation that did not happen.
      if (ephemeralPalId) await this.deletePal(ephemeralPalId).catch(() => undefined);
      throw err;
    }
  }

  async endSession(input: EndSessionInput): Promise<void> {
    let failure: unknown = null;
    try {
      await this.call("POST", `/v2/conversations/${encodeURIComponent(input.conversationId)}/end`);
    } catch (err) {
      // Already ended (a timeout, the visitor leaving) is the common case here.
      if (!(err instanceof VideoProviderError && (err.status === 400 || err.status === 404))) failure = err;
    }
    if (input.ephemeralPalId) {
      await this.deletePal(input.ephemeralPalId).catch((err) => (failure ??= err));
    }
    // Belline keeps its own transcript, so Tavus's copy can go with the call
    // when the owner has chosen that (docs/video/privacy-review.md).
    if (this.config.tavus.deleteAfterEnd) {
      await this.call("DELETE", `/v2/conversations/${encodeURIComponent(input.conversationId)}?hard=true`).catch((err) => {
        if (!(err instanceof VideoProviderError && err.status === 404)) failure ??= err;
      });
    }
    if (failure) throw failure;
  }

  verifyWebhook(rawBody: string, expected: { conversationId?: string }): WebhookVerdict {
    let payload: { conversation_id?: unknown; event_type?: unknown };
    try {
      payload = JSON.parse(rawBody) as typeof payload;
    } catch {
      return { ok: false, status: 400, reason: "not json" };
    }
    if (typeof payload.conversation_id !== "string" || typeof payload.event_type !== "string") {
      return { ok: false, status: 400, reason: "not a conversation event" };
    }
    // Tavus does not sign conversation callbacks. The URL's token is the
    // signature, and it only counts for the conversation it was issued for.
    if (!expected.conversationId || expected.conversationId !== payload.conversation_id) {
      return { ok: false, status: 403, reason: "conversation mismatch" };
    }
    return { ok: true, conversationId: payload.conversation_id, payload };
  }

  mapEvent(payload: unknown): VideoEvent {
    const event = payload as {
      event_type?: string;
      properties?: { shutdown_reason?: string; transcript?: { role?: string; content?: string }[] };
    };
    switch (event.event_type) {
      // The legacy duplicate carries the same payload; both mean the same thing.
      case "system.pal_joined":
      case "system.replica_joined":
        return { kind: "joined" };
      case "system.shutdown":
        return { kind: "ended", reason: String(event.properties?.shutdown_reason ?? "shutdown").slice(0, 120) };
      case "application.transcription_ready":
        return {
          kind: "transcript",
          turns: (event.properties?.transcript ?? [])
            .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
            .map((t) => ({ role: t.role === "user" ? ("caller" as const) : ("agent" as const), text: String(t.content) })),
        };
      default:
        return { kind: "ignored", eventType: String(event.event_type ?? "unknown").slice(0, 80) };
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Nothing about the visitor, and in per-session mode nothing secret either:
   * the PAL's api_key carries the token. In shared mode the token rides here,
   * and the model route only trusts it from a system message.
   */
  private context(input: CreateSessionInput, perSession: boolean): string {
    const lines = [`You are ${input.agentName}, the AI concierge for ${input.businessName}.`];
    if (!perSession) lines.push(`belline-session: ${input.llmToken}`);
    return lines.join("\n");
  }

  private async createPal(input: CreateSessionInput, faceId: string): Promise<string> {
    const template = await this.templateLayers(input.palId ?? this.config.tavus.palId);
    const created = await this.call<{ pal_id?: string; persona_id?: string }>("POST", "/v2/pals", {
      pal_name: `belline-${input.sessionId}`,
      // The real instructions are Belline's and live behind the model route.
      system_prompt: `You are ${input.agentName}, the AI concierge for ${input.businessName}. Your replies come from Belline.`,
      pipeline_mode: "full",
      default_face_id: faceId,
      languages: input.languages,
      // Belline discloses itself: the greeting says "AI concierge", the panel
      // labels it permanently, and the prompt answers "are you a person?". A
      // second, Tavus-worded disclosure before the greeting would be a third.
      disclosure_type: "off",
      layers: {
        ...template,
        llm: {
          model: "belline-receptionist",
          base_url: input.llmBaseUrl,
          api_key: input.llmToken,
          speculative_inference: this.config.tavus.speculative,
        },
        perception: { perception_model: "off" },
      },
    });
    const id = created.pal_id ?? created.persona_id;
    if (!id) throw new VideoProviderError("Tavus returned no PAL.", 502, true);
    return id;
  }

  /**
   * Voice, hearing and turn-taking from the owner's PAL, so the face sounds as chosen.
   *
   * Only the first session after a start waits for this GET. After that a
   * stale copy is used at once and refreshed in the background: the owner's
   * voice settings change rarely, and a visitor who tapped "Talk" should not
   * wait an extra round trip to Tavus after every ten minutes of quiet.
   */
  private async templateLayers(palId: string): Promise<Record<string, unknown>> {
    if (!palId) return {};
    const kept = this.template?.palId === palId ? this.template : null;
    if (kept) {
      if (Date.now() - kept.at >= TEMPLATE_TTL_MS && !this.templateRefresh) {
        this.templateRefresh = this.fetchTemplate(palId).finally(() => {
          this.templateRefresh = null;
        });
      }
      return kept.layers;
    }
    return this.fetchTemplate(palId);
  }

  private async fetchTemplate(palId: string): Promise<Record<string, unknown>> {
    try {
      const pal = await this.call<{ layers?: Record<string, unknown> }>("GET", `/v2/pals/${encodeURIComponent(palId)}`);
      const layers: Record<string, unknown> = {};
      for (const key of ["tts", "stt", "conversational_flow"]) {
        if (pal.layers?.[key]) layers[key] = pal.layers[key];
      }
      this.template = { at: Date.now(), palId, layers };
      return layers;
    } catch {
      // A missing template costs the chosen voice, not the call.
      return this.template?.palId === palId ? this.template.layers : {};
    }
  }
  private async deletePal(palId: string): Promise<void> {
    try {
      await this.call("DELETE", `/v2/pals/${encodeURIComponent(palId)}`);
    } catch (err) {
      if (!(err instanceof VideoProviderError && err.status === 404)) throw err;
    }
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.tavus.apiBase}${path}`, {
        method,
        headers: {
          "x-api-key": this.config.tavus.apiKey,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as { name?: string }).name === "AbortError";
      throw new VideoProviderError(aborted ? "Tavus did not answer in time." : "Could not reach Tavus.", 504, true);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      // Tavus's own words, short. Never the request, which carries tokens.
      let detail = "";
      try {
        const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
        detail = String(parsed.message ?? parsed.error ?? "");
      } catch {
        detail = "";
      }
      const concurrency = /concurrent/i.test(detail);
      throw new VideoProviderError(
        `Tavus ${method} ${path.split("/").slice(0, 3).join("/")} failed with ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
        res.status,
        res.status >= 500 || res.status === 429 || concurrency,
      );
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return {} as T;
    }
  }
}
