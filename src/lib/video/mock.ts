import crypto from "node:crypto";
import { stubsRefusal } from "../flags";
import {
  VideoProviderError,
  type CreateSessionInput,
  type CreatedSession,
  type EndSessionInput,
  type VideoAvatarProvider,
  type VideoEvent,
  type WebhookVerdict,
} from "./types";
import { TavusProvider } from "./tavus";
import { videoConfig } from "./config";

/**
 * A stand-in for Tavus, for local runs and the checks.
 *
 * It keeps the whole contract — sessions are created and ended, callbacks are
 * verified and mapped the way Tavus's are — and it records what it was asked,
 * so a test asserts on the conversation rather than on a return value. What it
 * cannot do is render a face: the panel shows a placeholder plainly labelled
 * "MOCK — not a live avatar", and the visitor's turns are typed and sent
 * through the same model route Tavus would call.
 *
 * Refused wherever the stub providers are refused: in production, and next to
 * a database that is not local. The flag already reports it unsafe there; this
 * is the second lock, on the object itself.
 */

type Env = Record<string, string | undefined>;

export interface MockRecord {
  created: CreateSessionInput[];
  ended: EndSessionInput[];
}

const globalRef = globalThis as unknown as { __bellineVideoMock?: MockRecord & { failNext: number } };

function record(): MockRecord & { failNext: number } {
  globalRef.__bellineVideoMock ??= { created: [], ended: [], failNext: 0 };
  return globalRef.__bellineVideoMock;
}

export function mockVideoRecord(): MockRecord {
  return record();
}

/** The next `count` creations fail as Tavus's would under a concurrency limit. */
export function failNextMockSessions(count = 1): void {
  record().failNext = count;
}

export function resetMockVideo(): void {
  globalRef.__bellineVideoMock = { created: [], ended: [], failNext: 0 };
}

/** The room URL scheme the panel recognises as the mock. */
export const MOCK_ROOM_PREFIX = "mock://belline-video/";

export class MockVideoProvider implements VideoAvatarProvider {
  readonly name = "mock" as const;
  readonly capabilities = { perception: false, captions: true };
  /** Tavus's own callback parsing, so the mock cannot drift from it. */
  private readonly events = new TavusProvider(videoConfig({ VIDEO_AVATAR_PROVIDER: "mock" }));

  constructor(env: Env = process.env) {
    const refusal = stubsRefusal(env);
    if (refusal) {
      throw new Error(refusal.replace("FLAG_STUBS=on", "VIDEO_AVATAR_PROVIDER=mock"));
    }
  }

  missingConfig(): string[] {
    return [];
  }

  async createSession(input: CreateSessionInput): Promise<CreatedSession> {
    const state = record();
    // A little latency, so the panel's connecting state is real in a demo.
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (state.failNext > 0) {
      state.failNext--;
      throw new VideoProviderError("Mock: User has reached maximum concurrent conversations", 400, true);
    }
    state.created.push(input);
    return {
      conversationId: `mock_${crypto.randomBytes(6).toString("hex")}`,
      roomUrl: `${MOCK_ROOM_PREFIX}${input.sessionId}`,
      meetingToken: `mock-meeting-${crypto.randomBytes(8).toString("hex")}`,
      faceId: input.faceId,
      // The mock's stand-in face is drawn on green when asked (client/calls.ts).
      greenscreen: Boolean(input.greenscreen),
    };
  }

  async endSession(input: EndSessionInput): Promise<void> {
    record().ended.push(input);
  }

  verifyWebhook(rawBody: string, expected: { conversationId?: string }): WebhookVerdict {
    return this.events.verifyWebhook(rawBody, expected);
  }

  mapEvent(payload: unknown): VideoEvent {
    return this.events.mapEvent(payload);
  }
}
