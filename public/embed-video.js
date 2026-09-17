/**
 * The video receptionist's round bubble, for a venue's website and belline.ai.
 *
 * Loaded by embed.js and site.js only when the venue's config says
 * `video: true`, after the page has painted. It never loads the Daily SDK,
 * never asks for the microphone and never creates a session. All of that
 * happens inside the call frame, and only after the visitor taps.
 *
 * What it does:
 *
 *   **Open on load, greeting.** A round bubble near the launcher, playing the
 *   venue's short greeting clip muted, looping and inline, over a poster, with
 *   the caption "Hi, I'm Belle, the AI concierge. Tap to talk." With no clip,
 *   with reduced motion or with Data Saver on, it shows the poster or the
 *   lettered placeholder instead, and loads no video at all.
 *
 *   **Tap to talk.** Tapping the bubble or "Talk to Belle" swaps it for the
 *   call frame (/embed/<key>/video?autostart=1). The live session starts there.
 *
 *   **One click closes.** The × dismisses the bubble for this browser session.
 *   The launcher's Video button brings it back. Closing during a call asks the
 *   frame to end the session, then removes it. The frame's own unload beacon is
 *   the backstop.
 *
 * Written for somebody else's page: no globals but `window.BellineVideo`, class
 * names prefixed `bvb-`, colours from Belline's tokens with fallbacks for pages
 * that do not load them, and every browser API reached through `env`, so
 * check:video can drive it without a browser.
 */
(function (root) {
  "use strict";

  var DISMISSED = "belline.video.bubble.dismissed";
  var END_GRACE_MS = 300;

  var CSS =
    ".bvb{position:relative;display:block;width:var(--bvb-size,200px);flex:none;" +
    "font:500 13px/1.35 var(--bl-font-text,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif);" +
    "color:var(--bl-ink-900,#1B2735);-webkit-font-smoothing:antialiased}" +
    ".bvb.bvb-fixed{position:fixed;z-index:41}" +
    ".bvb-circle{position:relative;display:block;width:var(--bvb-size,200px);height:var(--bvb-size,200px);padding:0;" +
    "border:0;border-radius:50%;overflow:hidden;cursor:pointer;background:var(--bl-navy,#1B2735);" +
    "box-shadow:0 0 0 3px var(--bl-ground,#FFFFFF),0 0 0 4px var(--bl-blue-line,#DDE3F5)," +
    "var(--bl-elev-float,0 12px 32px -16px rgba(27,39,53,.35))}" +
    ".bvb-circle:focus-visible,.bvb-talk:focus-visible,.bvb-shut:focus-visible{outline:2px solid var(--bl-focus-color,#2667FF);outline-offset:4px}" +
    ".bvb-media,.bvb-ph{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}" +
    ".bvb-ph{display:grid;place-items:center;background:radial-gradient(circle at 50% 40%,var(--bl-navy-card,#253041),var(--bl-navy,#1B2735) 72%)}" +
    ".bvb-ph span{display:grid;place-items:center;width:44%;height:44%;border-radius:50%;" +
    "font:600 calc(var(--bvb-size,200px)*.2)/1 var(--bl-font-display,system-ui,sans-serif);" +
    "color:var(--bl-blue-lit,#8FB0FF);background:var(--bl-navy-card,#253041);border:2px solid var(--bl-navy-line,rgba(255,255,255,.12));" +
    "animation:bvb-breathe 2.6s ease-in-out infinite}" +
    "@keyframes bvb-breathe{0%,100%{box-shadow:0 0 0 0 var(--bl-navy-line,rgba(255,255,255,.12))}50%{box-shadow:0 0 0 12px var(--bl-navy-line,rgba(255,255,255,.12))}}" +
    ".bvb-caption{display:block;position:absolute;left:8%;right:8%;bottom:9%;margin:0;padding:5px 8px;border-radius:10px;text-align:center;" +
    "font-size:calc(var(--bvb-size,200px)*.058);line-height:1.25;background:var(--bl-navy-card,#253041);color:var(--bl-on-navy,#FFFFFF)}" +
    ".bvb-ai{position:absolute;top:9%;left:50%;transform:translateX(-50%);white-space:nowrap;padding:3px 8px;border-radius:999px;" +
    "font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;" +
    "background:var(--bl-blue-tint,#EEF3FF);color:var(--bl-accent-text,#1A4FD6)}" +
    ".bvb-mock{position:absolute;top:23%;left:50%;transform:translateX(-50%);white-space:nowrap;padding:2px 7px;border-radius:999px;" +
    "font-size:10px;font-weight:700;background:var(--bl-warning-tint,#FFFBEB);color:var(--bl-warning,#B45309);border:1px solid var(--bl-warning,#B45309)}" +
    ".bvb-talk{display:flex;align-items:center;justify-content:center;width:100%;min-height:44px;margin-top:10px;padding:0 14px;" +
    "border:0;border-radius:999px;cursor:pointer;font:inherit;font-weight:600;font-size:14px;" +
    "background:var(--bl-blue,#2667FF);color:var(--bl-white,#FFFFFF);box-shadow:var(--bl-elev-float,0 12px 32px -16px rgba(27,39,53,.35))}" +
    ".bvb-shut{position:absolute;top:0;left:0;width:32px;height:32px;display:grid;place-items:center;padding:0;cursor:pointer;" +
    "border-radius:50%;border:1px solid var(--bl-rule-strong,rgba(27,39,53,.18));background:var(--bl-ground,#FFFFFF);" +
    "color:var(--bl-ink-900,#1B2735);font:18px/1 sans-serif;z-index:2}" +
    ".bvb-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}" +
    "@media (prefers-reduced-motion:reduce){.bvb-ph span{animation:none}}";

  function mount(opts) {
    var env = opts.env;
    var doc = env.document;
    var storage = env.sessionStorage;
    var cfg = opts.config || {};
    var agent = cfg.agentName || "Belle";
    var state = { bubble: null, call: null, shut: null, video: null, onKey: null };

    injectStyle();

    function injectStyle() {
      if (doc.getElementById && doc.getElementById("bvb-style")) return;
      var style = doc.createElement("style");
      style.id = "bvb-style";
      style.textContent = CSS;
      doc.head.appendChild(style);
    }

    function dismissed() {
      try {
        return storage && storage.getItem(DISMISSED) === "1";
      } catch (e) {
        return false;
      }
    }

    function remember(value) {
      try {
        if (!storage) return;
        if (value) storage.setItem(DISMISSED, "1");
        else storage.removeItem(DISMISSED);
      } catch (e) {
        /* storage is a convenience */
      }
    }

    function matches(query) {
      try {
        return Boolean(env.matchMedia && env.matchMedia(query).matches);
      } catch (e) {
        return false;
      }
    }

    /** No looping video for reduced motion or Data Saver: the poster instead. */
    function stillOnly() {
      var saveData = Boolean(env.navigator && env.navigator.connection && env.navigator.connection.saveData);
      return matches("(prefers-reduced-motion: reduce)") || saveData;
    }

    function absolute(url) {
      if (!url) return "";
      return url.charAt(0) === "/" && url.charAt(1) !== "/" ? opts.origin + url : url;
    }

    function el(tag, className, text) {
      var node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function showBubble() {
      if (state.bubble || state.call) return;
      if (opts.onBubbleShown) opts.onBubbleShown();

      var bubble = el("div", "bvb" + (opts.fixed ? " bvb-fixed" : ""));
      bubble.setAttribute("role", "region");
      bubble.setAttribute("aria-label", agent + ", AI concierge");
      bubble.setAttribute("data-belline-video", "bubble");

      var circle = el("button", "bvb-circle");
      circle.type = "button";
      circle.setAttribute("aria-label", "Talk to " + agent + ", the AI concierge, on a video call");

      // A path is on the app, not on the page the bubble sits in.
      var poster = absolute(cfg.posterUrl);
      var clip = absolute(cfg.clipUrl);
      if (clip && !stillOnly()) {
        var video = el("video", "bvb-media");
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.autoplay = true;
        video.setAttribute("muted", "");
        video.setAttribute("playsinline", "");
        video.setAttribute("loop", "");
        video.setAttribute("autoplay", "");
        video.setAttribute("preload", "none");
        video.setAttribute("aria-hidden", "true");
        if (poster) video.setAttribute("poster", poster);
        circle.appendChild(video);
        state.video = video;
        // After first paint: the clip never competes with the page for bandwidth.
        afterPaint(function () {
          if (state.video !== video) return;
          video.setAttribute("src", clip);
          try {
            var playing = video.play && video.play();
            if (playing && playing.catch) playing.catch(function () {});
          } catch (e) {
            /* the poster stays */
          }
        });
      } else if (poster) {
        var img = el("img", "bvb-media");
        img.setAttribute("src", poster);
        img.setAttribute("alt", "");
        img.setAttribute("decoding", "async");
        circle.appendChild(img);
      } else {
        var ph = el("span", "bvb-ph");
        ph.setAttribute("aria-hidden", "true");
        ph.appendChild(el("span", "", agent.charAt(0)));
        circle.appendChild(ph);
      }

      circle.appendChild(el("span", "bvb-ai", "AI concierge"));
      if (cfg.mock) circle.appendChild(el("span", "bvb-mock", "MOCK — not a live avatar"));
      circle.appendChild(el("span", "bvb-caption", "Hi, I'm " + agent + ", the AI concierge. Tap to talk."));
      circle.addEventListener("click", openCall);

      var shut = el("button", "bvb-shut", "×");
      shut.type = "button";
      shut.setAttribute("aria-label", "Close " + agent + "'s video greeting");
      shut.addEventListener("click", dismiss);

      var talk = el("button", "bvb-talk", "Talk to " + agent);
      talk.type = "button";
      talk.addEventListener("click", openCall);

      bubble.appendChild(circle);
      bubble.appendChild(shut);
      bubble.appendChild(talk);
      opts.place(bubble);
      state.bubble = bubble;
    }

    function afterPaint(fn) {
      var raf = env.requestAnimationFrame;
      var later = env.setTimeout;
      if (raf) raf(function () { later(fn, 0); });
      else later(fn, 0);
    }

    function removeBubble() {
      if (!state.bubble) return;
      if (state.video) {
        try {
          state.video.pause && state.video.pause();
          state.video.removeAttribute && state.video.removeAttribute("src");
        } catch (e) {
          /* already gone */
        }
      }
      state.video = null;
      state.bubble.remove();
      state.bubble = null;
    }

    /** The ×: gone for this browser session, back through the launcher's Video button. */
    function dismiss() {
      remember(true);
      removeBubble();
      if (opts.onDismissed) opts.onDismissed();
    }

    function openCall() {
      if (state.call) return;
      removeBubble();
      var frame = doc.createElement("iframe");
      frame.src =
        opts.origin +
        "/embed/" +
        encodeURIComponent(opts.key) +
        "/video?autostart=1&o=" +
        encodeURIComponent(opts.hostOrigin);
      frame.className = opts.frameClass || "";
      frame.title = "Video call with " + agent;
      // The microphone and sound, never the camera.
      frame.allow = "microphone; autoplay";
      frame.setAttribute("data-belline-video", "call");

      var shut = el("button", opts.shutClass || "", "×");
      shut.type = "button";
      shut.setAttribute("aria-label", "Close video call");
      shut.addEventListener("click", function () {
        closeCall();
      });

      state.call = frame;
      state.shut = shut;
      opts.placeCall(frame, shut);
      try {
        shut.focus();
      } catch (e) {
        /* focus is a nicety */
      }
      state.onKey = function (e) {
        if (e && e.key === "Escape") closeCall();
      };
      doc.addEventListener("keydown", state.onKey);
      if (opts.onCallOpened) opts.onCallOpened();
    }

    /**
     * End a call from the page: ask the frame to end its session, then take it
     * away. If the frame is already gone or slow, its unload beacon ends the
     * session on the server anyway.
     */
    function closeCall() {
      var frame = state.call;
      if (!frame) return;
      state.call = null;
      try {
        if (frame.contentWindow) frame.contentWindow.postMessage({ source: "belline-host", type: "end" }, opts.origin);
      } catch (e) {
        /* the beacon is the backstop */
      }
      if (state.shut) state.shut.remove();
      state.shut = null;
      if (state.onKey) doc.removeEventListener("keydown", state.onKey);
      state.onKey = null;
      frame.setAttribute("aria-hidden", "true");
      if (frame.style) frame.style.visibility = "hidden";
      env.setTimeout(function () {
        frame.remove();
      }, END_GRACE_MS);
      // Closing a call is not a dismissal of the greeting, but it does not
      // replay it either: the visitor has met Belle this session.
      remember(true);
      if (opts.onCallClosed) opts.onCallClosed();
    }

    if (!dismissed()) showBubble();

    return {
      /** The launcher's Video button: bring the bubble back. */
      reopen: function () {
        remember(false);
        showBubble();
      },
      openCall: openCall,
      closeCall: closeCall,
      dismiss: dismiss,
      state: function () {
        return { bubble: Boolean(state.bubble), call: Boolean(state.call), dismissed: dismissed() };
      },
    };
  }

  var api = { mount: mount, DISMISSED: DISMISSED, END_GRACE_MS: END_GRACE_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    root.BellineVideo = api;
    // Whoever loaded this may be waiting for it.
    var waiting = root.__bellineVideoReady;
    if (waiting && waiting.length) {
      root.__bellineVideoReady = [];
      for (var i = 0; i < waiting.length; i++) {
        try {
          waiting[i](api);
        } catch (e) {
          /* one host's failure is not another's */
        }
      }
    }
  }
})(typeof window !== "undefined" ? window : null);
