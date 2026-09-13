import type { WebSocket } from "ws";
import type { Transport } from "./session";

/**
 * Transports.
 *
 * `VoiceSession` does not know whether it is talking to a browser tab or to
 * the public telephone network. Both of these satisfy the same interface;
 * the differences — sample rate, framing, how you tell the far end to throw
 * away buffered audio — are contained entirely in here.
 */

export class BrowserTransport implements Transport {
  readonly input = { encoding: "linear16" as const, sampleRate: 16000 };
  readonly output = "pcm_16000" as const;
  /**
   * There is a screen on the other end of this one.
   *
   * Which changes what the session should do: times can be shown as well as
   * said, so the caller is not holding four of them in their head while
   * deciding. A telephone has no such luxury and must not be sent any.
   */
  readonly screen = true;

  constructor(private readonly socket: WebSocket) {}

  sendAudio(chunk: Buffer): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(chunk);
  }

  sendEvent(event: Record<string, unknown>): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(event));
    }
  }

  clearAudio(): void {
    this.sendEvent({ type: "clear" });
  }

  close(): void {
    this.socket.close();
  }
}

/**
 * Twilio Media Streams.
 *
 * Twilio expects 8 kHz µ-law in exactly 20 ms frames (160 bytes), base64'd,
 * tagged with the stream sid. Sending ragged chunks technically works and
 * sounds subtly wrong, so we re-frame. The `clear` message is what makes
 * barge-in audible on a real phone call — without it Twilio keeps playing
 * everything already buffered on its side, and the caller talks over an
 * agent that has, as far as our process is concerned, already stopped.
 */
export class TwilioTransport implements Transport {
  readonly input = { encoding: "mulaw" as const, sampleRate: 8000 };
  readonly output = "ulaw_8000" as const;
  /** A telephone. Everything has to be said out loud. */
  readonly screen = false;

  private carry: Buffer = Buffer.alloc(0);
  private static readonly FRAME = 160;

  constructor(
    private readonly socket: WebSocket,
    private readonly streamSid: string,
    /** Twilio's id for the phone call itself, which is what a transfer redirects. */
    private readonly callSid = "",
  ) {}

  /** Only a real phone call with a call id can be put through to somebody. */
  get canTransfer(): boolean {
    return Boolean(this.callSid && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
  }

  /**
   * Put the caller through to a person.
   *
   * Replaces the call's instructions while it is live: Twilio drops the media
   * stream to us and dials the number. If nobody picks up, the `action` route
   * tells the caller the team will ring back — the one thing this must never
   * do is leave somebody listening to silence.
   */
  async transfer(to: string): Promise<{ ok: boolean; detail?: string }> {
    if (!this.canTransfer) return { ok: false, detail: "No call id or Twilio credentials." };
    const sid = process.env.TWILIO_ACCOUNT_SID!;
    const token = process.env.TWILIO_AUTH_TOKEN!;
    const number = to.replace(/[^\d+]/g, "");
    const origin = (process.env.PUBLIC_ORIGIN || "https://app.belline.ai").replace(/\/$/, "");
    const twiml =
      `<Response><Dial timeout="25" action="${origin}/api/twilio/transfer" method="POST">` +
      `<Number>${number}</Number></Dial></Response>`;

    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls/${encodeURIComponent(this.callSid)}.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ Twiml: twiml }),
          signal: AbortSignal.timeout(6000),
        },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return { ok: false, detail: `Twilio ${res.status}: ${detail.slice(0, 160)}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  sendAudio(chunk: Buffer): void {
    const buf: Buffer = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    let offset = 0;
    while (buf.length - offset >= TwilioTransport.FRAME) {
      const frame = buf.subarray(offset, offset + TwilioTransport.FRAME);
      offset += TwilioTransport.FRAME;
      this.raw({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: frame.toString("base64") },
      });
    }
    this.carry = buf.subarray(offset);
  }

  sendEvent(): void {
    // The phone network has no channel for structured events; the dashboard
    // reads the call record instead.
  }

  clearAudio(): void {
    this.carry = Buffer.alloc(0);
    this.raw({ event: "clear", streamSid: this.streamSid });
  }

  close(): void {
    this.socket.close();
  }

  private raw(payload: Record<string, unknown>): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
