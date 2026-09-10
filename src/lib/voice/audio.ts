/**
 * Audio format plumbing.
 *
 * Two worlds meet here. The browser test console speaks 16 kHz signed 16-bit
 * PCM, because that is what an AudioWorklet produces and what speech models
 * prefer. The phone network speaks 8 kHz G.711 µ-law, because it has spoken
 * that since 1972 and will not be changing. Everything above this file works
 * in PCM16; only the telephony edge sees µ-law.
 */

const BIAS = 0x84;
const CLIP = 32635;

const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const inv = ~i & 0xff;
  const sign = inv & 0x80;
  const exponent = (inv >> 4) & 0x07;
  const mantissa = inv & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  MULAW_DECODE[i] = sign ? -sample : sample;
}

export function mulawToPcm16(mulaw: Buffer): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) out[i] = MULAW_DECODE[mulaw[i]];
  return out;
}

export function pcm16ToMulaw(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let sample = pcm[i];
    const sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;

    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
      exponent--;
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

/** Linear interpolation upsample — adequate for speech, and cheap. */
export function upsample2x(pcm: Int16Array): Int16Array {
  const out = new Int16Array(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const a = pcm[i];
    const b = i + 1 < pcm.length ? pcm[i + 1] : a;
    out[i * 2] = a;
    out[i * 2 + 1] = (a + b) >> 1;
  }
  return out;
}

/** Averaging decimation, which avoids the aliasing hiss of plain dropping. */
export function downsample2x(pcm: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor(pcm.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = (pcm[i * 2] + pcm[i * 2 + 1]) >> 1;
  }
  return out;
}

export function int16ToBuffer(pcm: Int16Array): Buffer {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

export function bufferToInt16(buf: Buffer): Int16Array {
  // Node buffers are not guaranteed to be 2-byte aligned, so copy when they
  // are not — a misaligned view throws rather than producing noise.
  if (buf.byteOffset % 2 === 0) {
    return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  }
  const copy = Buffer.from(buf);
  return new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 2));
}

/**
 * Rough loudness of a frame, 0..1. Used only to decide whether the caller is
 * actually talking over the agent or just breathing near the microphone.
 */
export function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length) / 32768;
}
