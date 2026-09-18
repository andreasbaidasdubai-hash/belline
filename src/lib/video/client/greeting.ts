/**
 * Playing the greeting clip, and knowing whether it was really heard.
 *
 * The clip's whole job is to fill the seconds a live session takes to exist,
 * so it has to start on the tap itself — that gesture is the only moment a
 * mobile browser will let a page make a sound. Everything here is therefore
 * written to be called from inside the press and to answer one question
 * honestly: *did the visitor hear this?* Only a `true` is allowed to shorten
 * the live greeting (`lib/video/greeting-clip.ts`), because a `false` that
 * lied would leave somebody in silence with a Belle who never says hello.
 *
 * The three ways it can be false are all ordinary, not errors:
 *
 *   - There is no clip. The venue has none configured, or the file 404s.
 *   - The browser refuses `play()`. Autoplay policy, a muted device profile,
 *     or a gesture the browser did not count.
 *   - `play()` resolves too slowly to wait for. The session request is the
 *     slow thing on this page and must not queue behind a video element; past
 *     `PLAY_TIMEOUT_MS` we give up on the clip rather than delay the call.
 *
 * In every one of those the element is put back exactly as it was — muted and
 * looping, the silent preview it has always been — and the caller carries on
 * down the path it took before this file existed.
 */

/** How long a `play()` may take before the clip is written off. */
export const PLAY_TIMEOUT_MS = 400;

/**
 * A clip that has stopped being a clip.
 *
 * `ended` is the honest signal, but a media element can also stall, be torn
 * off the page, or never reach its own last frame. This cap means the live
 * face is never held back by a clip that has quietly given up.
 */
const OVERRUN_MS = 2_000;

export interface PlayingGreeting {
  /** The visitor is hearing it. The only value that may shorten the live greeting. */
  played: boolean;
  /** Resolves when the last word has been said — or at once, when nothing is playing. */
  done: Promise<void>;
  /**
   * Resolves `leadMs` before the clip ends.
   *
   * The live call joins here rather than at `done`: the provider speaks once a
   * participant is in the room, and the room takes a moment to join, so
   * handing over a beat early puts that moment under the clip's last words
   * instead of in the silence after them.
   */
  beforeEnd: (leadMs: number) => Promise<void>;
}

/** Nothing is playing: the caller behaves exactly as it did before. */
const SILENT: PlayingGreeting = { played: false, done: Promise.resolve(), beforeEnd: () => Promise.resolve() };

export function noGreeting(): PlayingGreeting {
  return SILENT;
}

/**
 * Start the clip with its sound, from the visitor's own tap.
 *
 * Call this synchronously inside the event handler. The returned promise
 * settles in a few milliseconds when the browser is willing and at
 * `PLAY_TIMEOUT_MS` at the very worst, so awaiting it before creating the
 * session costs nothing anybody can feel.
 */
export async function playGreeting(el: HTMLVideoElement | null | undefined): Promise<PlayingGreeting> {
  if (!el) return SILENT;
  // She only speaks if she can be seen. Reduced motion hides the clip in CSS
  // (and Data Saver never loads it), and a voice coming out of a face that is
  // not there is worse than the wait it replaces. Asking the layout rather
  // than re-reading the media query keeps one rule instead of two that can
  // drift apart.
  if (!el.offsetWidth || !el.offsetHeight) return SILENT;

  // Exactly as it was, if any of this does not work out.
  const restore = () => {
    try {
      el.muted = true;
      el.loop = true;
      void el.play().catch(() => undefined);
    } catch {
      /* an element that has gone away needs no restoring */
    }
  };

  let playing: Promise<void>;
  try {
    el.loop = false;
    el.muted = false;
    el.currentTime = 0;
    playing = el.play() ?? Promise.resolve();
  } catch {
    restore();
    return SILENT;
  }

  const timedOut = Symbol("slow");
  const raced = await Promise.race([
    playing.then(() => true).catch(() => false),
    new Promise<typeof timedOut>((r) => setTimeout(() => r(timedOut), PLAY_TIMEOUT_MS)),
  ]);
  if (raced !== true) {
    restore();
    return SILENT;
  }

  // `ended` is the honest signal. The cap is for everything that stops a clip
  // without reaching it — a backgrounded tab pausing it, a stalled buffer, an
  // element torn off the page — because the live face is waiting on this, and
  // a promise that never settles is a call that never starts.
  const done = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("ended", finish);
      el.removeEventListener("error", finish);
      clearTimeout(cap);
      resolve();
    };
    el.addEventListener("ended", finish, { once: true });
    el.addEventListener("error", finish, { once: true });
    const cap = setTimeout(finish, remainingMs(el) + OVERRUN_MS);
  });

  return {
    played: true,
    done,
    beforeEnd: (leadMs: number) =>
      Promise.race([done, new Promise<void>((r) => setTimeout(r, Math.max(0, remainingMs(el) - leadMs)))]),
  };
}

/**
 * The clip is playing in the page around us, not here.
 *
 * The bubble's tap happens in the venue's own page, and a cross-origin frame
 * cannot borrow that gesture, so the page plays the clip and this frame simply
 * follows along. `durationMs` comes with the frame's URL, because the tap and
 * the frame are made in the same instant and a message would race the frame's
 * own listener; the page's later "ended" message calls `finish` and is the
 * authority when it arrives. The timer is only there so a page that never
 * sends it cannot strand the live face behind a clip that stopped long ago.
 */
export function hostGreeting(durationMs: number): PlayingGreeting & { finish: () => void } {
  const startedAt = Date.now();
  const left = () => Math.max(0, durationMs - (Date.now() - startedAt));
  let finish = () => undefined as void;
  const done = new Promise<void>((resolve) => {
    const cap = setTimeout(resolve, left() + OVERRUN_MS);
    finish = () => {
      clearTimeout(cap);
      resolve();
    };
  });
  return {
    played: true,
    done,
    beforeEnd: (leadMs: number) => Promise.race([done, new Promise<void>((r) => setTimeout(r, Math.max(0, left() - leadMs)))]),
    finish: () => finish(),
  };
}

/** How much of the clip is left, in ms. Zero when the browser does not know yet. */
function remainingMs(el: HTMLVideoElement): number {
  const total = Number.isFinite(el.duration) ? el.duration : 0;
  const at = Number.isFinite(el.currentTime) ? el.currentTime : 0;
  return Math.max(0, Math.round((total - at) * 1000));
}
