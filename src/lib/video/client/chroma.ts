/**
 * The face on a Belline background: a chroma key over Tavus's green screen.
 *
 * With `properties.apply_greenscreen` Tavus replaces the face's room with a
 * green of RGB [0, 255, 155], and leaves the replacement to the page ("customize
 * it on the frontend using WebGL")
 * — https://docs.tavus.io/api-reference/conversations/create-conversation ·
 * https://docs.tavus.io/sections/conversational-video-interface/conversation/customizations/background-customizations
 *
 * WebGL where the browser has it (one draw per video frame, the key and the
 * composite in a fragment shader); a 2D canvas at reduced size where it does
 * not. Either way the stream as it is (`raw`) wins whenever keying would be
 * worse than no keying:
 *
 *   - the frame shows no green where green should be (Tavus did not apply it:
 *     a Phoenix-4.5 face, or a change on their side),
 *   - the device is too slow (median frame time over the first frames),
 *   - the battery is low and not charging.
 *
 * Work happens only while it can be seen: paused while the tab is hidden or
 * the circle is off screen, and at 15 frames a second under
 * `prefers-reduced-motion`. No dependency.
 */

export type ChromaMode = "webgl" | "2d" | "raw";
export type RawReason = "no_green" | "slow" | "battery" | "unsupported" | "error";

export const TAVUS_GREEN: readonly [number, number, number] = [0, 255, 155];

/** How far a colour is from the key, 0 (the key) to ~1.4, in chroma only (YCbCr), so shadows on green still key. */
export function chromaDistance(r: number, g: number, b: number, key: readonly [number, number, number] = TAVUS_GREEN): number {
  const cb = (x: readonly number[]) => (-0.168736 * x[0] - 0.331264 * x[1] + 0.5 * x[2]) / 255;
  const cr = (x: readonly number[]) => (0.5 * x[0] - 0.418688 * x[1] - 0.081312 * x[2]) / 255;
  const p = [r, g, b];
  return Math.hypot(cb(p) - cb(key), cr(p) - cr(key)) * 2;
}

/** Foreground opacity for a pixel: 0 on the key, 1 well away from it, a soft edge between. */
export function keyAlpha(r: number, g: number, b: number, similarity = 0.28, smoothness = 0.12): number {
  const d = chromaDistance(r, g, b);
  const t = (d - similarity) / smoothness;
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/**
 * Is this frame a green screen? The top corners of a head-and-shoulders shot
 * are background; most of their pixels must be close to the key.
 */
export function looksKeyed(data: Uint8ClampedArray, width: number, height: number): boolean {
  let near = 0;
  let total = 0;
  const band = Math.max(1, Math.floor(Math.min(width, height) / 6));
  for (let y = 0; y < band; y++) {
    for (const x0 of [0, width - band]) {
      for (let x = x0; x < x0 + band; x++) {
        const i = (y * width + x) * 4;
        total++;
        if (chromaDistance(data[i], data[i + 1], data[i + 2]) < 0.3) near++;
      }
    }
  }
  return total > 0 && near / total >= 0.6;
}

/** The median of a list of timings. */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Frames measured before deciding the device can keep up, and the budget per frame. */
export const SAMPLE_FRAMES = 30;
export const BUDGET_MS: Record<"webgl" | "2d", number> = { webgl: 10, "2d": 14 };

export interface ChromaOptions {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  background: HTMLImageElement;
  /** Told once which mode it settled on, and again if it falls back later. */
  onMode: (mode: ChromaMode, reason?: RawReason) => void;
}

export interface ChromaHandle {
  stop(): void;
}

const VERTEX = `
attribute vec2 p;
varying vec2 uv;
void main() { uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAGMENT = `
precision mediump float;
varying vec2 uv;
uniform sampler2D face;
uniform sampler2D bg;
uniform vec2 faceScale;
uniform vec2 faceOffset;
uniform vec3 keyColor;
vec2 chroma(vec3 c) {
  return vec2(-0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b, 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b);
}
void main() {
  vec3 b = texture2D(bg, uv).rgb;
  vec2 fuv = uv * faceScale + faceOffset;
  vec3 f = texture2D(face, fuv).rgb;
  float d = distance(chroma(f), chroma(keyColor)) * 2.0;
  float a = smoothstep(0.28, 0.40, d);
  // Spill: take the green cast off the edges the key leaves behind.
  float spill = max(0.0, f.g - max(f.r, f.b));
  f.g -= spill * (1.0 - a) * 0.9 + spill * 0.35;
  gl_FragColor = vec4(mix(b, f, a), 1.0);
}`;

/** The part of a video of w×h that "object-fit: cover" shows in a square. */
function coverTransform(w: number, h: number): { scale: [number, number]; offset: [number, number] } {
  if (!w || !h) return { scale: [1, 1], offset: [0, 0] };
  return w >= h ? { scale: [h / w, 1], offset: [(1 - h / w) / 2, 0] } : { scale: [1, w / h], offset: [0, (1 - w / h) / 2] };
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

async function batteryLow(): Promise<boolean> {
  try {
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ charging: boolean; level: number }> };
    if (!nav.getBattery) return false;
    const battery = await nav.getBattery();
    return !battery.charging && battery.level <= 0.2;
  } catch {
    return false;
  }
}

export function startChromaKey(opts: ChromaOptions): ChromaHandle {
  const { video, canvas, background, onMode } = opts;
  let stopped = false;
  let mode: ChromaMode | null = null;
  let frameHandle = 0;
  let visible = typeof document === "undefined" || !document.hidden;
  let onScreen = true;
  const timings: number[] = [];
  const minGapMs = reducedMotion() ? 1000 / 15 : 0;
  let lastDraw = 0;
  let checkedGreen = false;

  // A tiny 2D canvas, for the green check and the 2D path's own work.
  const probe = document.createElement("canvas");
  const probeCtx = probe.getContext("2d", { willReadFrequently: true });

  const settle = (next: ChromaMode, reason?: RawReason) => {
    if (mode === next) return;
    mode = next;
    onMode(next, reason);
    if (next === "raw") stop();
  };

  // ---- WebGL -------------------------------------------------------------
  let gl: WebGLRenderingContext | null = null;
  let faceTex: WebGLTexture | null = null;
  let scaleLoc: WebGLUniformLocation | null = null;
  let offsetLoc: WebGLUniformLocation | null = null;

  function setupWebGl(): boolean {
    try {
      gl = canvas.getContext("webgl", { premultipliedAlpha: false, antialias: false, powerPreference: "low-power" }) as WebGLRenderingContext | null;
      if (!gl) return false;
      const compile = (type: number, source: string) => {
        const shader = gl!.createShader(type)!;
        gl!.shaderSource(shader, source);
        gl!.compileShader(shader);
        if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) throw new Error("shader");
        return shader;
      };
      const program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const at = gl.getAttribLocation(program, "p");
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
      const texture = (unit: number) => {
        const t = gl!.createTexture()!;
        gl!.activeTexture(gl!.TEXTURE0 + unit);
        gl!.bindTexture(gl!.TEXTURE_2D, t);
        gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
        gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
        gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
        gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
        return t;
      };
      texture(1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, background);
      faceTex = texture(0);
      gl.uniform1i(gl.getUniformLocation(program, "face"), 0);
      gl.uniform1i(gl.getUniformLocation(program, "bg"), 1);
      gl.uniform3f(gl.getUniformLocation(program, "keyColor"), TAVUS_GREEN[0] / 255, TAVUS_GREEN[1] / 255, TAVUS_GREEN[2] / 255);
      scaleLoc = gl.getUniformLocation(program, "faceScale");
      offsetLoc = gl.getUniformLocation(program, "faceOffset");
      return true;
    } catch {
      gl = null;
      return false;
    }
  }

  function drawWebGl() {
    const size = Math.min(720, Math.max(video.videoWidth, video.videoHeight) || 480);
    if (canvas.width !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    const g = gl!;
    g.viewport(0, 0, size, size);
    const { scale, offset } = coverTransform(video.videoWidth, video.videoHeight);
    g.uniform2f(scaleLoc, scale[0], scale[1]);
    g.uniform2f(offsetLoc, offset[0], offset[1]);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, faceTex);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGB, g.RGB, g.UNSIGNED_BYTE, video);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  }

  // ---- 2D ----------------------------------------------------------------
  const ctx2d = () => canvas.getContext("2d");
  const SIZE_2D = 320;

  function draw2d() {
    const ctx = ctx2d();
    if (!ctx || !probeCtx) throw new Error("2d");
    if (canvas.width !== SIZE_2D) {
      canvas.width = SIZE_2D;
      canvas.height = SIZE_2D;
    }
    probe.width = SIZE_2D;
    probe.height = SIZE_2D;
    const { scale, offset } = coverTransform(video.videoWidth, video.videoHeight);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    probeCtx.drawImage(video, offset[0] * vw, offset[1] * vh, scale[0] * vw, scale[1] * vh, 0, 0, SIZE_2D, SIZE_2D);
    const frame = probeCtx.getImageData(0, 0, SIZE_2D, SIZE_2D);
    ctx.drawImage(background, 0, 0, SIZE_2D, SIZE_2D);
    const back = ctx.getImageData(0, 0, SIZE_2D, SIZE_2D);
    const f = frame.data;
    const o = back.data;
    for (let i = 0; i < f.length; i += 4) {
      const a = keyAlpha(f[i], f[i + 1], f[i + 2]);
      if (a === 0) continue;
      const spill = Math.max(0, f[i + 1] - Math.max(f[i], f[i + 2]));
      const green = f[i + 1] - spill * ((1 - a) * 0.9 + 0.35);
      o[i] = o[i] + (f[i] - o[i]) * a;
      o[i + 1] = o[i + 1] + (green - o[i + 1]) * a;
      o[i + 2] = o[i + 2] + (f[i + 2] - o[i + 2]) * a;
    }
    ctx.putImageData(back, 0, 0);
  }

  // ---- The loop ----------------------------------------------------------
  function greenCheck(): boolean {
    if (!probeCtx || !video.videoWidth) return true;
    probe.width = 48;
    probe.height = 48;
    const { scale, offset } = coverTransform(video.videoWidth, video.videoHeight);
    probeCtx.drawImage(video, offset[0] * video.videoWidth, offset[1] * video.videoHeight, scale[0] * video.videoWidth, scale[1] * video.videoHeight, 0, 0, 48, 48);
    return looksKeyed(probeCtx.getImageData(0, 0, 48, 48).data, 48, 48);
  }

  const hasFrameCallback = typeof (video as HTMLVideoElement & { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === "function";

  function schedule() {
    if (stopped || !visible || !onScreen) return;
    if (hasFrameCallback) {
      frameHandle = (video as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(tick);
    } else {
      frameHandle = requestAnimationFrame(tick);
    }
  }

  function tick() {
    if (stopped) return;
    const now = performance.now();
    if (video.readyState < 2 || (minGapMs && now - lastDraw < minGapMs)) {
      schedule();
      return;
    }
    lastDraw = now;
    try {
      if (!checkedGreen) {
        checkedGreen = true;
        if (!greenCheck()) {
          settle("raw", "no_green");
          return;
        }
      }
      const started = performance.now();
      if (mode === "webgl") drawWebGl();
      else draw2d();
      if (timings.length < SAMPLE_FRAMES) {
        timings.push(performance.now() - started);
        if (timings.length === SAMPLE_FRAMES && median(timings) > BUDGET_MS[mode === "webgl" ? "webgl" : "2d"]) {
          settle("raw", "slow");
          return;
        }
      }
    } catch {
      settle("raw", "error");
      return;
    }
    schedule();
  }

  function cancel() {
    if (!frameHandle) return;
    if (hasFrameCallback) (video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void }).cancelVideoFrameCallback?.(frameHandle);
    else cancelAnimationFrame(frameHandle);
    frameHandle = 0;
  }

  const onVisibility = () => {
    visible = !document.hidden;
    cancel();
    schedule();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          onScreen = entries.some((e) => e.isIntersecting);
          cancel();
          schedule();
        })
      : null;
  observer?.observe(canvas);

  function stop() {
    if (stopped) return;
    stopped = true;
    cancel();
    document.removeEventListener("visibilitychange", onVisibility);
    observer?.disconnect();
  }

  void (async () => {
    if (await batteryLow()) {
      settle("raw", "battery");
      return;
    }
    if (stopped) return;
    const start = (m: "webgl" | "2d") => {
      mode = m;
      onMode(m);
      schedule();
    };
    const go = () => {
      if (setupWebGl()) start("webgl");
      else if (ctx2d() && probeCtx) start("2d");
      else settle("raw", "unsupported");
    };
    if (background.complete && background.naturalWidth) go();
    else {
      background.addEventListener("load", go, { once: true });
      background.addEventListener("error", () => settle("raw", "error"), { once: true });
    }
  })();

  return { stop };
}
