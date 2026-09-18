import crypto from "node:crypto";
import { missingVideoConfig, type VideoConfig } from "./config";
import { dropRetiredPals, forgetVenuePal, readVenuePal, readVideoControl, recordVenuePal } from "./control";
import { sharedContextBroken } from "./shared-pal";
import { CONTEXT_TOKEN_LABEL, venuePalKey } from "./tokens";
import {
  VideoProviderError,
  type CreateSessionInput,
  type CreatedSession,
  type EndSessionInput,
  type VenuePalSpec,
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
 * OpenAI-compatible LLM. The docs document no per-conversation header,
 * metadata or LLM override on Create Conversation — only the PAL's static
 * `layers.llm` (`api_key`, `headers`, `extra_body`, `default_query`).
 *
 * **`shared` (default): one PAL per venue and face**, made once (pre-warmed at
 * boot and when video is switched on) and reused, whose `api_key` is a static
 * key derived for that venue and face. Each conversation carries its session
 * token in `conversational_context`; the model route reads it only from a
 * system message and requires the key and the token to agree on the venue.
 * That removes a GET and a POST (and a DELETE at the end) from every start.
 *
 * **`per_session`**: a short-lived PAL per call whose `api_key` is the session
 * token, deleted at the end — the rollback, and what a venue falls back to if
 * a shared request ever arrives without its token (shared-pal.ts).
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

/** Tavus saying the PAL a conversation named does not exist (a 404, or a 400 that says so). */
function missingPal(err: unknown): boolean {
  if (!(err instanceof VideoProviderError)) return false;
  return err.status === 404 || (err.status === 400 && /(pal|persona)/i.test(err.message) && /(not found|does not exist|invalid|deleted)/i.test(err.message));
}

export class TavusProvider implements VideoAvatarProvider {
  readonly name = "tavus" as const;
  readonly capabilities = { perception: false, captions: true };
  private template: TemplatePal | null = null;
  private templateRefresh: Promise<unknown> | null = null;
  /** Shared PALs being made right now, so a burst of visitors makes one. */
  private readonly making = new Map<string, Promise<string>>();

  constructor(
    private readonly config: VideoConfig,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
  ) {}

  missingConfig(): string[] {
    return missingVideoConfig(this.config);
  }

  async createSession(input: CreateSessionInput): Promise<CreatedSession> {
    const faceId = input.faceId ?? this.config.tavus.faceId;
    const shared = this.config.tavus.palMode === "shared" && !sharedContextBroken(input.locationId);
    const spec: VenuePalSpec = { locationId: input.locationId, faceId, languages: input.languages, llmBaseUrl: input.llmBaseUrl, palId: input.palId };

    if (!shared) {
      const ephemeralPalId = await this.createPal(input, faceId);
      try {
        return { ...(await this.createConversation(input, faceId, ephemeralPalId, false)), ephemeralPalId, pal: "per_session" };
      } catch (err) {
        // Never leave a PAL behind for a conversation that did not happen.
        await this.deletePal(ephemeralPalId).catch(() => undefined);
        throw err;
      }
    }

    const venue = await this.venuePal(spec);
    try {
      return { ...(await this.createConversation(input, faceId, venue.palId, true)), pal: venue.made ? "shared_cold" : "shared_warm" };
    } catch (err) {
      // Somebody deleted the kept PAL in Tavus's dashboard: make it again, once.
      if (!missingPal(err)) throw err;
      forgetVenuePal(input.locationId, faceId, venue.palId);
      const again = await this.venuePal(spec);
      return { ...(await this.createConversation(input, faceId, again.palId, true)), pal: "shared_cold" };
    }
  }

  /**
   * Make or refresh the venue's shared PAL before any visitor needs it (server
   * boot, video switched on, a new face chosen), and delete PALs it replaced
   * once no call can still be using them.
   */
  async prewarm(spec: VenuePalSpec): Promise<void> {
    await this.venuePal(spec);
    await this.sweepRetiredPals();
  }

  /** The conversation itself: only the fields that change something. */
  private async createConversation(input: CreateSessionInput, faceId: string, palId: string, shared: boolean) {
    const body = {
      face_id: faceId,
      pal_id: palId,
      // An id, not the venue: conversation names show in Tavus's dashboard.
      conversation_name: `belline-${input.sessionId}`,
      callback_url: input.callbackUrl,
      custom_greeting: input.greeting,
      conversational_context: this.context(input, shared),
      // Private room: the browser needs the meeting token, which lives as
      // long as `participant_absent_timeout`.
      require_auth: true,
      ...(input.euPolicy ? { policy: "eu" } : {}),
      ...(this.config.tavus.testMode ? { test_mode: true } : {}),
      properties: {
        max_call_duration: input.maxCallSeconds,
        participant_left_timeout: input.leftTimeoutSeconds,
        participant_absent_timeout: input.absentTimeoutSeconds,
        // The default, sent anyway: the privacy review promises it in writing.
        enable_recording: false,
        // Not sent: `enable_closed_captions` (Daily's transcription, which the
        // panel does not read — its captions are Tavus's utterance events) and
        // `apply_greenscreen: false` (the default).
        ...(input.greenscreen ? { apply_greenscreen: true } : {}),
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
      faceId,
      greenscreen: Boolean(input.greenscreen),
    };
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
  private context(input: CreateSessionInput, shared: boolean): string {
    const lines = [`You are ${input.agentName}, the AI concierge for ${input.businessName}.`];
    if (shared) lines.push(`${CONTEXT_TOKEN_LABEL}: ${input.llmToken}`);
    return lines.join("\n");
  }

  /**
   * One PAL body for both kinds. The real instructions are Belline's and live
   * behind the model route, so nothing here names the business: a venue's
   * shared PAL changes only when its face, languages, voice or key do.
   */
  private async palBody(opts: { name: string; faceId: string; languages: string[]; llmBaseUrl: string; apiKey: string; templatePalId?: string }) {
    const template = await this.templateLayers(opts.templatePalId ?? this.config.tavus.palId);
    const voice = this.config.tavus.externalVoice;
    return {
      pal_name: opts.name,
      system_prompt: "You are the AI concierge on this business's website. Your replies come from Belline.",
      pipeline_mode: "full",
      default_face_id: opts.faceId,
      languages: opts.languages,
      // Belline discloses itself: the greeting says "AI concierge", the panel
      // labels it permanently, and the prompt answers "are you a person?". A
      // second, Tavus-worded disclosure before the greeting would be a third.
      disclosure_type: "off",
      layers: {
        ...template,
        // Option (b) of the voice plan: a public provider voice, no key sent
        // (https://docs.tavus.io/sections/conversational-video-interface/pal/tts).
        ...(voice ? { tts: { tts_engine: voice.engine, external_voice_id: voice.voiceId } } : {}),
        llm: {
          model: "belline-receptionist",
          base_url: opts.llmBaseUrl,
          api_key: opts.apiKey,
          speculative_inference: this.config.tavus.speculative,
        },
        perception: { perception_model: "off" },
      },
    };
  }

  private async createPal(input: CreateSessionInput, faceId: string): Promise<string> {
    const body = await this.palBody({
      name: `belline-${input.sessionId}`,
      faceId,
      languages: input.languages,
      llmBaseUrl: input.llmBaseUrl,
      apiKey: input.llmToken,
      templatePalId: input.palId,
    });
    return this.postPal(body);
  }

  private async postPal(body: unknown): Promise<string> {
    const created = await this.call<{ pal_id?: string; persona_id?: string }>("POST", "/v2/pals", body);
    const id = created.pal_id ?? created.persona_id;
    if (!id) throw new VideoProviderError("Tavus returned no PAL.", 502, true);
    return id;
  }

  /**
   * The venue's shared PAL for this face: the kept one when nothing it was
   * built from has changed (no network at all), otherwise a new one, made once
   * however many visitors ask at the same moment. The one it replaces is
   * retired and deleted later by `sweepRetiredPals`, never under a live call.
   */
  private async venuePal(spec: VenuePalSpec): Promise<{ palId: string; made: boolean }> {
    const apiKey = venuePalKey(spec.locationId, spec.faceId);
    const body = await this.palBody({
      name: `belline-venue-${spec.locationId}`,
      faceId: spec.faceId,
      languages: spec.languages,
      llmBaseUrl: spec.llmBaseUrl,
      apiKey,
      templatePalId: spec.palId,
    });
    // The key itself is not hashed in: a fingerprint of it is, so a rotated
    // VIDEO_LLM_SECRET makes a new PAL instead of a PAL whose key is refused.
    const fingerprint = crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify({ ...body, layers: { ...body.layers, llm: { ...body.layers.llm, api_key: fingerprint } } }))
      .digest("hex");

    const kept = readVenuePal(spec.locationId, spec.faceId);
    if (kept && kept.hash === hash) return { palId: kept.palId, made: false };

    const flight = `${spec.locationId}|${spec.faceId}|${hash}`;
    let making = this.making.get(flight);
    if (!making) {
      making = this.postPal(body)
        .then((palId) => {
          recordVenuePal(spec.locationId, { palId, faceId: spec.faceId, hash, createdAt: new Date().toISOString() });
          return palId;
        })
        .finally(() => this.making.delete(flight));
      this.making.set(flight, making);
    }
    return { palId: await making, made: true };
  }

  /** Delete replaced PALs once the longest possible call on them is over. */
  private async sweepRetiredPals(now = Date.now()): Promise<void> {
    const graceMs = (1800 + 15 * 60) * 1000;
    const due = readVideoControl().retiredPals.filter((p) => now - Date.parse(p.at) >= graceMs);
    const gone: string[] = [];
    for (const pal of due) {
      await this.deletePal(pal.palId).then(
        () => gone.push(pal.palId),
        () => undefined,
      );
    }
    dropRetiredPals(gone);
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
      // Tavus's wording for a plan at capacity, as seen in the docs and in the
      // wild: "maximum concurrent conversations", "concurrency limit reached".
      // No API reports the plan's number, so this string is the only signal
      // that our configured ceiling is above the account's.
      const concurrency = /concurren|at capacity/i.test(detail);
      throw new VideoProviderError(
        `Tavus ${method} ${path.split("/").slice(0, 3).join("/")} failed with ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
        res.status,
        res.status >= 500 || res.status === 429 || concurrency,
        concurrency,
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
