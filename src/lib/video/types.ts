/**
 * The video receptionist's contract with whoever renders the face.
 *
 * Belline owns the conversation — the prompt, the tools, the booking engine,
 * the call record, the usage — and a provider owns only the face, the ears and
 * the mouth. This interface is where that line is drawn, so a second provider
 * is one file (`mock.ts` is the proof that it is) and nothing above it knows
 * which one is running.
 *
 * See docs/video/plan.md and docs/video/tavus-notes.md.
 */

export type VideoProviderName = "tavus" | "mock";

export interface ProviderCapabilities {
  /** Whether the provider can look at the visitor's camera. Belline keeps it off. */
  perception: boolean;
  /** Whether live captions arrive in the call. */
  captions: boolean;
}

export interface CreateSessionInput {
  /** Belline's id for this session. Never the venue's name or anything personal. */
  sessionId: string;
  /** The venue, for its shared PAL. An id, never shown to Tavus as a name. */
  locationId: string;
  businessName: string;
  agentName: string;
  /** Spoken by the provider before the model is ever asked anything. */
  greeting: string;
  /** BCP-47-ish codes the provider accepts, first one opened in. */
  languages: string[];
  maxCallSeconds: number;
  /** Abandoned before anybody joined: the provider shuts the room after this. */
  absentTimeoutSeconds: number;
  /** After the visitor leaves: the provider shuts the room after this. */
  leftTimeoutSeconds: number;
  /** The secret that authenticates the provider's model requests for this one session. */
  llmToken: string;
  /** Where the provider sends model requests, without `/chat/completions`. */
  llmBaseUrl: string;
  /** Where the provider sends lifecycle events, token included. */
  callbackUrl: string;
  /** Ask the provider's EU settings (disclosure, limited emotion inference). */
  euPolicy: boolean;
  /** A face other than the deployment's default, when a venue has one. */
  faceId?: string;
  /** A PAL other than the deployment's default, when a venue has one. */
  palId?: string;
  /** Ask for a green background the panel replaces (only where the face supports it). */
  greenscreen?: boolean;
}

/** What a venue's shared PAL is built from; also what pre-warming needs. */
export interface VenuePalSpec {
  locationId: string;
  faceId: string;
  languages: string[];
  llmBaseUrl: string;
  palId?: string;
}

export interface CreatedSession {
  conversationId: string;
  /** The room the browser joins. */
  roomUrl: string;
  /** Short-lived, one room. Present when the room is private. */
  meetingToken?: string;
  /** A PAL made for this session alone, to be deleted with it. */
  ephemeralPalId?: string;
  /** How the PAL was had: the venue's kept one, one made now for the venue, or one for this call alone. */
  pal?: "shared_warm" | "shared_cold" | "per_session";
  /** The face actually used. */
  faceId?: string;
  /** Whether the conversation was asked for a green background. */
  greenscreen?: boolean;
}

export interface EndSessionInput {
  conversationId: string;
  ephemeralPalId?: string;
}

/** What a provider's lifecycle callback meant, in Belline's words. */
export type VideoEvent =
  | { kind: "joined" }
  | { kind: "ended"; reason: string }
  | { kind: "transcript"; turns: { role: "agent" | "caller"; text: string }[] }
  | { kind: "ignored"; eventType: string };

export type WebhookVerdict =
  | { ok: true; conversationId: string; payload: unknown }
  | { ok: false; status: 400 | 401 | 403; reason: string };

export interface VideoAvatarProvider {
  readonly name: VideoProviderName;
  readonly capabilities: ProviderCapabilities;
  /** The env var names still missing, never their values. */
  missingConfig(): string[];
  createSession(input: CreateSessionInput): Promise<CreatedSession>;
  /** Make or refresh a venue's reusable PAL ahead of any visitor. Absent: nothing to warm. */
  prewarm?(spec: VenuePalSpec): Promise<void>;
  endSession(input: EndSessionInput): Promise<void>;
  /**
   * Is this callback really about a session we started? `expected` is the
   * conversation the callback URL's token was issued for.
   */
  verifyWebhook(rawBody: string, expected: { conversationId?: string }): WebhookVerdict;
  mapEvent(payload: unknown): VideoEvent;
}

/** A provider failure that is safe to log and to classify. Never carries a key. */
export class VideoProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Worth trying again in a moment: a timeout, a 5xx, a concurrency limit. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "VideoProviderError";
  }
}
