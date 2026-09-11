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
  ) {}

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
