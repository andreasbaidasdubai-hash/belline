/**
 * The video receptionist's round bubble, for a venue's website and belline.ai.
 *
 * Loaded by embed.js and site.js only when the venue's config says
 * `video: true`, after the page has painted. It never loads the call SDK,
 * never asks for the microphone and never creates a session. All of that
 * happens inside the call frame, and only after the visitor taps.
 *
 * One round thing, in four sizes:
 *
 *   **Resting (the size on every fresh load).** The face (the venue's muted
 *   greeting clip, a poster or a lettered placeholder), as big as the call's
 *   circle, with "AI concierge" on its top edge and a × on its shoulder. Under
 *   it one row: "Talk to Belle", and beside it one round icon button for each
 *   other way in the page offers, the chat and WhatsApp. Voice has no button
 *   of its own: on the web, voice is the face. The icons ring gently (the
 *   bell's own beat) where the host asks for it, never under reduced motion,
 *   and stop for good once the visitor touches the bubble. On a wide screen a
 *   short pill, "Hi, I'm Belle — tap to talk", sits above the face; on a
 *   narrow one it is dropped.
 *
 *   **In a call.** Tapping the face or "Talk to Belle" keeps the same circle
 *   and lays the call frame (/embed/<key>/video?autostart=1&bubble=1) over it:
 *   a transparent page whose own circle, pills and controls line up with this
 *   one. The face's muted preview keeps playing while the session is made,
 *   and the live face fades in over it. The live session starts inside the
 *   frame.
 *
 *   **Picture in picture (a phone, in a call).** Scrolling the page or tapping
 *   outside the call shrinks it to a small round face in a corner, still live
 *   and audible. The same frame, positioned and clipped by CSS only: it is
 *   never moved in the page, so the call never reloads or drops. Drag it
 *   anywhere; tap it to grow the call back; press and hold (or hover, or tab
 *   to it) for a tiny mute and end.
 *
 *   **Small.** Only the × does this: the bubble shrinks to a small face beside
 *   the icons for the rest of the tab's session (sessionStorage). Tapping the
 *   face brings the bubble back. Ending a call is not a dismissal: the bubble
 *   comes back at full size. Closing during a call ends the call first: the
 *   frame is asked to end its session and its unload beacon is the backstop.
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
  var GROW_MS = 420;
  /** How far the page scrolls during a call on a phone before the call tucks itself into a corner. */
  var PIP_SCROLL_PX = 48;
  var PIP_HOLD_MS = 450;
  var PIP_CONTROLS_MS = 4000;
  var PIP_MARGIN = 12;
  /** How many times the icons ring after load, and how long that takes (the last icon starts 1.7 s late). */
  var RINGS = 3;
  var RING_MS = RINGS * 1500 + 1700;

  var BLUE = "var(--bl-blue,#0071E3)";
  var INK = "var(--bl-ink-900,#1D1D1F)";
  var GREY = "var(--bl-text-2,#6E6E73)";
  var SURFACE = "var(--bl-surface,#F5F5F7)";
  var WHITE = "var(--bl-ground,#FFFFFF)";
  var LINE = "var(--bl-blue-line,#D2D2D7)";
  var FLOAT = "var(--bl-elev-float,0 12px 32px -16px rgba(0,0,0,.3))";

  var CSS =
    // The current circle is one variable, so the pills and the × follow it through every size.
    // At rest it is the call's own size: the bubble a visitor first sees is the circle they talk to.
    ".bvb{--bvb-call:min(320px,calc(100vw - 48px),calc(100dvh - 250px));--bvb-cur:var(--bvb-size,var(--bvb-call));" +
    "position:relative;display:block;width:var(--bvb-cur);flex:none;box-sizing:border-box;" +
    "font:500 13px/1.35 var(--bl-font-text,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif);" +
    "color:" + INK + ";-webkit-font-smoothing:antialiased;text-align:left}" +
    ".bvb *{box-sizing:border-box}" +
    ".bvb[hidden]{display:none}.bvb.bvb-fixed{position:fixed;z-index:41}" +
    ".bvb.is-call{--bvb-cur:max(180px,var(--bvb-call))}" +
    ".bvb.is-mini{--bvb-cur:56px}" +
    "@media (max-width:520px){.bvb{--bvb-call:min(240px,calc(100vw - 40px),calc(100dvh - 230px))}}" +
    // The face.
    ".bvb-circle{position:relative;display:block;width:var(--bvb-cur);height:var(--bvb-cur);padding:0;margin:0;" +
    "border:0;border-radius:50%;overflow:hidden;cursor:pointer;background:var(--bl-navy,#1D1D1F);transform-origin:0 0;" +
    "box-shadow:0 0 0 3px " + WHITE + ",0 0 0 4px " + LINE + "," + FLOAT + "}" +
    ".bvb.is-call .bvb-circle{position:absolute;top:0;right:0;cursor:default}" +
    ".bvb.bvb-left.is-call .bvb-circle{right:auto;left:0}" +
    ".bvb.is-growing .bvb-circle{transition:transform " + GROW_MS + "ms cubic-bezier(.2,.8,.2,1)}" +
    ".bvb-circle:focus-visible,.bvb-talk:focus-visible,.bvb-shut:focus-visible,.bvb-act:focus-visible,.bvb-pipface:focus-visible,.bvb-pipbtn:focus-visible" +
    "{outline:2px solid var(--bl-focus-color,#0071E3);outline-offset:3px}" +
    ".bvb-media,.bvb-ph{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}" +
    ".bvb-ph{display:grid;place-items:center;background:radial-gradient(circle at 50% 40%,var(--bl-navy-card,#333336),var(--bl-navy,#1D1D1F) 72%)}" +
    ".bvb-ph span{display:grid;place-items:center;width:44%;height:44%;border-radius:50%;" +
    "font:600 calc(var(--bvb-cur)*.2)/1 var(--bl-font-display,system-ui,sans-serif);" +
    "color:var(--bl-blue-lit,#2997FF);background:var(--bl-navy-card,#333336);border:2px solid var(--bl-navy-line,rgba(255,255,255,.12));" +
    "animation:bvb-breathe 2.6s ease-in-out infinite}" +
    "@keyframes bvb-breathe{0%,100%{box-shadow:0 0 0 0 var(--bl-navy-line,rgba(255,255,255,.12))}50%{box-shadow:0 0 0 12px var(--bl-navy-line,rgba(255,255,255,.12))}}" +
    // "AI concierge", always: on the circle's top edge, outside its clip, above the call frame.
    ".bvb-tags{position:absolute;left:50%;top:0;transform:translate(-50%,-50%);display:flex;pointer-events:none;z-index:3}" +
    ".bvb.is-call .bvb-tags{left:auto;right:calc(var(--bvb-cur)/2);transform:translate(50%,-50%)}" +
    ".bvb.bvb-left.is-call .bvb-tags{right:auto;left:calc(var(--bvb-cur)/2);transform:translate(-50%,-50%)}" +
    ".bvb-ai{white-space:nowrap;padding:3px 9px;border-radius:999px;font-size:10.5px;line-height:1.3;font-weight:600;letter-spacing:.06em;text-transform:uppercase;" +
    "background:var(--bl-blue-tint,#F0F6FE);color:var(--bl-accent-text,#0066CC);border:1px solid " + LINE + "}" +
    ".bvb.is-mini .bvb-ai{font-size:8.5px;padding:2px 6px;letter-spacing:.04em}" +
    ".bvb-mock{position:absolute;left:50%;top:var(--bvb-cur);transform:translate(-50%,-50%);z-index:2;pointer-events:none;" +
    "white-space:nowrap;padding:2px 7px;border-radius:999px;" +
    "font-size:10px;font-weight:700;background:var(--bl-warning-tint,#FFFBEB);color:var(--bl-warning,#B45309);border:1px solid var(--bl-warning,#B45309)}" +
    ".bvb.is-call .bvb-mock,.bvb.is-mini .bvb-mock{display:none}" +
    // The greeting line: a short pill above the face, inside the bubble's own column, on a wide
    // screen only. Never beside it over the page, and dropped on a phone.
    ".bvb-caption{position:absolute;left:50%;bottom:calc(100% + 20px);transform:translateX(-50%);" +
    "width:max-content;max-width:calc(var(--bvb-cur) + 24px);margin:0;padding:6px 12px;border-radius:999px;white-space:nowrap;" +
    "font-size:13px;line-height:1.35;background:" + WHITE + ";color:" + INK + ";" +
    "border:1px solid " + LINE + ";box-shadow:" + FLOAT + ";pointer-events:none}" +
    ".bvb.is-call .bvb-caption,.bvb.is-mini .bvb-caption{display:none}" +
    "@media (max-width:900px){.bvb-caption{display:none}}" +
    // One row under the face: the primary button, then the round icons.
    ".bvb-row{position:relative;display:flex;align-items:center;gap:8px;margin-top:14px}" +
    ".bvb-mock~.bvb-row{margin-top:20px}" +
    // A host whose face is the only way to talk (belline.ai): the icons alone, centred.
    ".bvb-row.is-icons{justify-content:center}" +
    ".bvb-talk{flex:1 1 auto;min-width:0;display:flex;align-items:center;justify-content:center;min-height:48px;padding:0 12px;margin:0;" +
    "border:0;border-radius:999px;cursor:pointer;font:inherit;font-weight:600;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
    "background:" + BLUE + ";color:#FFFFFF;box-shadow:" + FLOAT + "}" +
    ".bvb-talk:hover{background:var(--bl-blue-hover,#006EDB)}" +
    ".bvb-act{position:relative;isolation:isolate;flex:none;width:48px;height:48px;padding:0;margin:0;display:grid;place-items:center;" +
    "border-radius:50%;border:1px solid var(--bl-rule-strong,#D2D2D7);background:" + WHITE + ";color:" + BLUE + ";cursor:pointer;" +
    "box-shadow:0 0 0 3px " + WHITE + "," + FLOAT + ";text-decoration:none;transition:transform .16s ease}" +
    ".bvb-act svg{width:22px;height:22px;display:block}" +
    ".bvb-act:hover{background:" + SURFACE + ";transform:translateY(-2px)}" +
    ".bvb.bvb-left .bvb-row{flex-direction:row-reverse}" +
    "@media (max-width:520px){.bvb-row{gap:6px}.bvb-talk{font-size:13.5px;padding:0 10px}.bvb-act{width:46px;height:46px}}" +
    // The ring: the bell's own beat on belline.ai (bell-shake, bell-nudge, bell-ring), value for value.
    ".bvb-act::after{content:'';position:absolute;inset:0;border-radius:inherit;border:2px solid " + BLUE + ";pointer-events:none;opacity:0;z-index:-1}" +
    // Three rings after load, then still: a bubble that never stops ringing is an alarm, not a greeting.
    ".bvb-act.is-ringing{animation:bvb-bell-nudge 1.5s ease-in-out " + RINGS + "}" +
    ".bvb-act.is-ringing svg{animation:bvb-bell-shake 1.5s ease-in-out " + RINGS + "}" +
    ".bvb-act.is-ringing::after{animation:bvb-bell-ring 1.5s ease-out " + RINGS + "}" +
    // One after the other, as on belline.ai: two buttons in step would be an alarm.
    ".bvb-act.is-ringing[data-kind=chat],.bvb-act.is-ringing[data-kind=chat] svg,.bvb-act.is-ringing[data-kind=chat]::after{animation-delay:1.2s}" +
    ".bvb-act.is-ringing[data-kind=whatsapp],.bvb-act.is-ringing[data-kind=whatsapp] svg,.bvb-act.is-ringing[data-kind=whatsapp]::after{animation-delay:1.7s}" +
    "@keyframes bvb-bell-shake{0%,27%,100%{transform:rotate(0deg)}2%{transform:rotate(-22deg)}4%{transform:rotate(22deg)}" +
    "6%{transform:rotate(-19deg)}8%{transform:rotate(19deg)}10%{transform:rotate(-15deg)}12%{transform:rotate(15deg)}" +
    "14%{transform:rotate(-11deg)}16%{transform:rotate(11deg)}18%{transform:rotate(-8deg)}20%{transform:rotate(8deg)}" +
    "22%{transform:rotate(-4deg)}24%{transform:rotate(4deg)}}" +
    "@keyframes bvb-bell-nudge{0%,14%,100%{transform:translateY(0) rotate(0deg)}3%{transform:translateY(-2px) rotate(-1.6deg)}" +
    "7%{transform:translateY(-2px) rotate(1.6deg)}11%{transform:translateY(-1px) rotate(-.8deg)}}" +
    "@keyframes bvb-bell-ring{0%{transform:scale(1);opacity:.55}55%{transform:scale(1.28);opacity:0}100%{transform:scale(1.28);opacity:0}}" +
    // Small: the face alone, the icons beside it on the inner side.
    ".bvb.is-mini .bvb-row{position:absolute;margin:0;bottom:4px;right:calc(100% + 8px);width:max-content}" +
    ".bvb.bvb-left.is-mini .bvb-row{right:auto;left:calc(100% + 8px)}" +
    ".bvb.is-mini .bvb-talk,.bvb.is-call .bvb-row{display:none}" +
    // The call frame: exactly the circle's width, laid over it, transparent around it.
    ".bvb-frame{position:relative;display:block;width:var(--bvb-cur);height:calc(var(--bvb-cur) + 150px);margin:0;padding:0;border:0;" +
    "background:transparent;color-scheme:light;z-index:1;opacity:0;transition:opacity .25s ease}" +
    ".bvb-frame.is-ready{opacity:1}" +
    // The × at the circle's upper outer corner.
    ".bvb-shut{position:absolute;top:calc(var(--bvb-cur)*.146 - 14px);right:-12px;width:30px;height:30px;display:grid;place-items:center;padding:0;margin:0;cursor:pointer;" +
    "border-radius:50%;border:1px solid var(--bl-rule-strong,rgba(0,0,0,.18));background:" + WHITE + ";" +
    "color:" + INK + ";font:18px/1 sans-serif;z-index:5;box-shadow:" + FLOAT + "}" +
    ".bvb.bvb-left .bvb-shut{right:auto;left:-12px}" +
    ".bvb.is-mini .bvb-shut{display:none}" +
    ".bvb.is-growing .bvb-tags,.bvb.is-growing .bvb-shut{opacity:0}" +
    ".bvb-tags,.bvb-shut{transition:opacity .2s ease " + Math.round(GROW_MS * 0.6) + "ms}" +
    // Picture in picture: the same frame, fixed in a corner and clipped to the face. Nothing is moved in the page.
    ".bvb.is-pip{--bvb-cur:96px;position:fixed;z-index:2147483000;height:var(--bvb-cur);" +
    "right:calc(" + PIP_MARGIN + "px + env(safe-area-inset-right,0px));bottom:calc(96px + env(safe-area-inset-bottom,0px));left:auto;top:auto;touch-action:none}" +
    ".bvb.is-pip .bvb-frame{clip-path:circle(calc(var(--bvb-cur) / 2) at 50% calc(var(--bvb-cur) / 2));pointer-events:none;transition:none}" +
    ".bvb.is-pip .bvb-tags,.bvb.is-pip .bvb-shut,.bvb.is-pip .bvb-caption,.bvb.is-pip .bvb-mock{display:none}" +
    ".bvb-pipface,.bvb-pipbar{display:none}" +
    ".bvb.is-pip .bvb-pipface{display:block;position:absolute;top:0;left:0;width:var(--bvb-cur);height:var(--bvb-cur);z-index:6;padding:0;margin:0;" +
    "border:0;border-radius:50%;background:transparent;cursor:grab;touch-action:none;-webkit-tap-highlight-color:transparent}" +
    ".bvb.is-pip.is-dragging .bvb-pipface{cursor:grabbing}" +
    ".bvb.is-pip .bvb-pipbar{display:flex;position:absolute;left:50%;top:calc(100% + 6px);transform:translateX(-50%);gap:6px;z-index:7;" +
    "opacity:0;pointer-events:none;transition:opacity .15s ease}" +
    ".bvb.is-pip.is-pipctl .bvb-pipbar,.bvb.is-pip:focus-within .bvb-pipbar{opacity:1;pointer-events:auto}" +
    "@media (hover:hover){.bvb.is-pip:hover .bvb-pipbar{opacity:1;pointer-events:auto}}" +
    ".bvb-pipbtn{width:34px;height:34px;display:grid;place-items:center;padding:0;margin:0;border-radius:50%;cursor:pointer;" +
    "border:1px solid var(--bl-rule-strong,rgba(0,0,0,.18));background:" + WHITE + ";color:" + INK + ";box-shadow:" + FLOAT + "}" +
    ".bvb-pipbtn svg{width:18px;height:18px;display:block}" +
    ".bvb-pipbtn[aria-pressed=true]{background:" + INK + ";color:#FFFFFF;border-color:" + INK + "}" +
    ".bvb-pipbtn.bvb-pipend{background:var(--bl-danger,#D70015);border-color:var(--bl-danger,#D70015);color:#FFFFFF}" +
    ".bvb-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}" +
    "@media (prefers-reduced-motion:reduce){.bvb-ph span{animation:none}" +
    ".bvb.is-growing .bvb-circle,.bvb-frame,.bvb-tags,.bvb-shut{transition:none}" +
    ".bvb-act,.bvb-act.is-ringing,.bvb-act.is-ringing svg,.bvb-act.is-ringing::after{animation:none!important;transition:none}" +
    ".bvb-act::after{opacity:0}.bvb-pipbar{transition:none}}";

  // Icons, drawn in the same hand as embed.js's.
  var ICONS = {
    chat:
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M3 11.2C3 6.9 7.03 3.5 12 3.5s9 3.4 9 7.7c0 4.3-4.03 7.7-9 7.7a11 11 0 0 1-2.4-.26L5.4 20.5l.5-3.2A7.7 7.7 0 0 1 3 11.2Z" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
      '<circle cx="8.2" cy="11.2" r="1.15" fill="currentColor"/><circle cx="12" cy="11.2" r="1.15" fill="currentColor"/>' +
      '<circle cx="15.8" cy="11.2" r="1.15" fill="currentColor"/></svg>',
    whatsapp:
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.9L3.6 20.4l4.1-1.1A8.5 8.5 0 1 0 12 3.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<path d="M9.2 8.6c.2-.4.4-.4.6-.4h.5c.2 0 .4 0 .5.4l.7 1.6c.1.2 0 .4-.1.5l-.5.6c-.1.1-.1.3 0 .4a6 6 0 0 0 2.6 2.5c.2.1.3.1.4 0l.6-.7c.1-.2.3-.2.5-.1l1.6.7c.2.1.4.2.4.4 0 .3 0 1-.4 1.4-.5.5-1.2.7-1.8.6a7.9 7.9 0 0 1-5.7-5.6c-.1-.6 0-1.3.6-1.8Z" fill="currentColor"/></svg>',
    mic:
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/>' +
      '<path d="M6 11a6 6 0 0 0 12 0M12 17v3M9 20h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    end:
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M3.5 14.5c4.6-4.2 12.4-4.2 17 0l-2.3 2.6-3.3-1.4v-2.3a9.6 9.6 0 0 0-5.8 0v2.3l-3.3 1.4Z" fill="currentColor"/></svg>',
  };

  function mount(opts) {
    var env = opts.env;
    var doc = env.document;
    var storage = env.sessionStorage;
    var cfg = opts.config || {};
    var agent = cfg.agentName || "Belle";
    var words = opts.strings || {};
    var state = {
      root: null,
      circle: null,
      row: null,
      acts: [],
      shut: null,
      call: null,
      video: null,
      mode: null,
      ringing: false,
      pip: false,
      pipFace: null,
      pipMute: null,
      muted: false,
      pipArmY: 0,
      pipTimer: null,
      onKey: null,
      onMessage: null,
      onScroll: null,
      onOutside: null,
      readyTimer: null,
    };

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
        return Boolean(storage) && storage.getItem(DISMISSED) === "1";
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

    function reducedMotion() {
      return matches("(prefers-reduced-motion: reduce)");
    }

    /** No looping video for reduced motion or Data Saver: the poster instead. */
    function stillOnly() {
      var saveData = Boolean(env.navigator && env.navigator.connection && env.navigator.connection.saveData);
      return reducedMotion() || saveData;
    }

    /** Picture in picture is for a phone-sized screen, where a call circle covers the page. */
    function pipAllowed() {
      return matches("(max-width: 900px)");
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

    /**
     * The page's other ways in, as round icons: the chat and WhatsApp. A voice
     * call has no icon here, because on the web voice is the face.
     */
    function actions() {
      var given = opts.actions || opts.others;
      var list = typeof given === "function" ? given() : given;
      return (list || []).filter(function (o) {
        return o && o.label && typeof o.run === "function" && o.kind !== "voice";
      });
    }

    function setMode(mode) {
      state.mode = mode;
      if (!state.root) return;
      // The page's own classes on the bubble (site.js adds one) are kept.
      var theirs = String(state.root.className || "")
        .split(" ")
        .filter(function (c) {
          return c && !/^(bvb|bvb-fixed|bvb-left|is-call|is-mini|is-growing|is-pip|is-pipctl|is-dragging)$/.test(c);
        });
      state.root.className =
        (theirs.length ? theirs.join(" ") + " " : "") +
        "bvb" +
        (opts.fixed ? " bvb-fixed" : "") +
        (opts.side === "left" ? " bvb-left" : "") +
        (mode === "call" ? " is-call" : mode === "mini" ? " is-mini" : "") +
        (mode === "call" && state.pip ? " is-pip" : "");
      state.root.setAttribute("data-state", mode);
      state.root.setAttribute("data-pip", mode === "call" && state.pip ? "on" : "off");
      if (state.circle) {
        state.circle.setAttribute(
          "aria-label",
          mode === "call"
            ? agent + ", AI concierge, on a video call"
            : mode === "mini"
              ? "Video call with " + agent + ", the AI concierge"
              : words.face || "Talk to " + agent + ", the AI concierge, on a video call",
        );
      }
    }

    function build() {
      if (state.root) return;
      var root = el("div", "bvb");
      root.setAttribute("role", "region");
      root.setAttribute("aria-label", agent + ", AI concierge");
      root.setAttribute("data-belline-video", "bubble");

      var circle = el("button", "bvb-circle");
      circle.type = "button";

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
          playPreview();
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
      circle.addEventListener("click", function () {
        if (state.mode === "mini") reopen();
        // The greeting starts inside the press, before anything else: a browser
        // grants sound only to the handler the tap is still in, and this page's
        // tap is the only one there is — the call frame is on another origin
        // and cannot borrow it.
        else if (state.mode === "rest") openCall(speakGreeting());
      });

      var tags = el("span", "bvb-tags");
      tags.appendChild(el("span", "bvb-ai", "AI concierge"));

      var caption = el("p", "bvb-caption", words.caption || "Hi, I'm " + agent + " — tap to talk");
      caption.setAttribute("aria-hidden", "true");

      var row = el("div", "bvb-row");
      // A host may leave the button out (`talkButton: false`) where the face says it all: tapping it starts the call.
      if (opts.talkButton === false) {
        row.className = "bvb-row is-icons";
      } else {
        var talk = el("button", "bvb-talk", words.talk || "Talk to " + agent);
        talk.type = "button";
        // Wrapped, not passed: this is a tap like the circle's, so it gets the
        // greeting too — and handing `openCall` the click event straight would
        // quietly make it the clip's length.
        talk.addEventListener("click", function () {
          openCall(speakGreeting());
        });
        row.appendChild(talk);
      }

      actions().forEach(function (o) {
        var act = el("button", "bvb-act");
        act.type = "button";
        act.setAttribute("data-kind", o.kind || "");
        act.setAttribute("aria-label", o.label);
        act.setAttribute("title", o.label);
        act.innerHTML = ICONS[o.kind] || ICONS.chat;
        act.addEventListener("click", function () {
          stopRinging();
          o.run();
        });
        row.appendChild(act);
        state.acts.push(act);
      });

      var shut = el("button", "bvb-shut", "×");
      shut.type = "button";
      shut.addEventListener("click", function () {
        if (state.mode === "call") closeCall();
        else dismiss();
      });

      root.appendChild(circle);
      root.appendChild(tags);
      if (cfg.mock) root.appendChild(el("span", "bvb-mock", "MOCK — not a live avatar"));
      root.appendChild(caption);
      root.appendChild(row);
      root.appendChild(shut);

      state.root = root;
      state.circle = circle;
      state.row = row;
      state.shut = shut;
      setMode(dismissed() ? "mini" : "rest");
      setShutLabel();
      opts.place(root);
      startRinging();
      if (opts.onBubbleShown) opts.onBubbleShown();
    }

    function setShutLabel() {
      if (!state.shut) return;
      state.shut.setAttribute("aria-label", state.mode === "call" ? words.closeCall || "Close video call" : "Close " + agent + "'s video greeting");
    }

    function playPreview() {
      var video = state.video;
      if (!video) return;
      try {
        var playing = video.play && video.play();
        if (playing && playing.catch) playing.catch(function () {});
      } catch (e) {
        /* the poster stays */
      }
    }

    function pausePreview() {
      try {
        if (state.video && state.video.pause) state.video.pause();
      } catch (e) {
        /* already still */
      }
    }

    /**
     * Belle's opening words, said out of this page, on the visitor's tap.
     *
     * The clip has been looping silently in the circle since first paint, so
     * by the time anybody taps it is decoded, buffered and already playing —
     * all this does is take the mute off and start it again from the top,
     * inside the gesture, which is the one thing that makes a phone allow a
     * sound. Nothing is downloaded and nothing is waited for, so the first
     * word lands on the tap rather than after the connection.
     *
     * Returns how long she will be talking for, in milliseconds, which the
     * frame needs so it can time the live face's arrival to her last word.
     * Zero means no greeting: no clip, a poster-only bubble, reduced motion,
     * Data Saver, or a clip the browser has not got far enough with to promise
     * anything. Zero is the old behaviour in every one of those cases — the
     * frame connects as it always did and the live Belle says the whole
     * greeting herself.
     */
    function speakGreeting() {
      var video = state.video;
      // `greets` is the config saying this clip is our greeting and has words
      // in it. Without it the circle is showing the provider's stock preview of
      // the face, which is silent — unmuting that would greet nobody and cost
      // the live hello as well.
      if (!cfg.greets) return 0;
      // HAVE_FUTURE_DATA or better: it is genuinely playing, not merely created.
      if (!video || !video.play || stillOnly() || video.readyState < 3) return 0;
      var ms = Math.round((Number(video.duration) > 0 ? video.duration : 0) * 1000);
      if (!ms) return 0;
      try {
        video.loop = false;
        video.removeAttribute("loop");
        video.muted = false;
        video.removeAttribute("muted");
        video.currentTime = 0;
        var playing = video.play();
        // Refused after all. Put the circle back the way it was and tell the
        // frame at once, so it neither waits for a clip that is not speaking
        // nor leaves the visitor with a Belle who never says hello.
        if (playing && playing.catch) playing.catch(greetingFailed);
      } catch (e) {
        greetingFailed();
        return 0;
      }
      video.addEventListener("ended", greetingEnded);
      video.addEventListener("error", greetingFailed);
      state.greeting = true;
      return ms;
    }

    /** Silent and looping again, as the resting bubble has always been. */
    function restoreSilentPreview() {
      var video = state.video;
      state.greeting = false;
      if (!video) return;
      try {
        video.removeEventListener("ended", greetingEnded);
        video.removeEventListener("error", greetingFailed);
        video.muted = true;
        video.setAttribute("muted", "");
        video.loop = true;
        video.setAttribute("loop", "");
      } catch (e) {
        /* an element mid-teardown needs nothing put back */
      }
    }

    function greetingEnded() {
      restoreSilentPreview();
      tellFrame({ type: "greeting_ended" });
    }

    function greetingFailed() {
      restoreSilentPreview();
      tellFrame({ type: "greeting_failed" });
    }

    /**
     * A word to the call frame.
     *
     * Said more than once on purpose: the frame is created in the same instant
     * as the tap and may not have a listener yet, and these two messages
     * decide whether the visitor is greeted twice or not at all. Repeating a
     * message the frame has already acted on costs nothing — both are
     * idempotent on the other side.
     */
    function tellFrame(message) {
      var attempts = 0;
      var send = function () {
        attempts++;
        try {
          if (state.call && state.call.contentWindow) {
            state.call.contentWindow.postMessage({ source: "belline-host", type: message.type }, opts.origin);
          }
        } catch (e) {
          /* a frame that has gone cannot be told */
        }
        if (attempts < 4) env.setTimeout(send, 80);
      };
      send();
    }

    function afterPaint(fn) {
      var raf = env.requestAnimationFrame;
      var later = env.setTimeout;
      if (raf) raf(function () { later(fn, 0); });
      else later(fn, 0);
    }

    // --- the ring ---------------------------------------------------------------

    /**
     * The icons ring on the bell's beat where the host asks (belline.ai always;
     * a venue's site when the venue chose ringing). Never under reduced motion,
     * and it stops for good the first time the visitor touches the bubble.
     */
    function startRinging() {
      if (!opts.ring || state.ringing || !state.acts.length || reducedMotion() || state.mode === "mini") return;
      state.ringing = true;
      state.acts.forEach(function (act) {
        act.className = "bvb-act is-ringing";
      });
      state.onInterest = stopRinging;
      ["pointerdown", "pointerenter", "focusin", "keydown", "touchstart"].forEach(function (type) {
        state.root.addEventListener(type, state.onInterest);
      });
      // The CSS rings RINGS times; after that the icons are simply still.
      env.setTimeout(stopRinging, RING_MS);
    }

    function stopRinging() {
      if (!state.ringing) return;
      state.ringing = false;
      state.acts.forEach(function (act) {
        act.className = "bvb-act";
      });
      if (state.onInterest && state.root) {
        ["pointerdown", "pointerenter", "focusin", "keydown", "touchstart"].forEach(function (type) {
          state.root.removeEventListener(type, state.onInterest);
        });
      }
      state.onInterest = null;
    }

    // --- sizes ----------------------------------------------------------------

    /**
     * Grow or shrink the circle in place: measure it, change the layout, and
     * animate from where it was (FLIP), so the face never jumps. Instant under
     * reduced motion, and wherever the page cannot measure.
     */
    function resize(mode, rearrange) {
      var circle = state.circle;
      var before = measurable(circle) ? circle.getBoundingClientRect() : null;
      // Whatever else changes the layout happens after the first measure.
      if (rearrange) rearrange();
      setMode(mode);
      setShutLabel();
      if (!before || reducedMotion()) return;
      var after = circle.getBoundingClientRect();
      if (!after.width) return;
      var s = before.width / after.width;
      var root = state.root;
      circle.style.transition = "none";
      circle.style.transform = "translate(" + (before.left - after.left) + "px," + (before.top - after.top) + "px) scale(" + s + ")";
      root.className += " is-growing";
      // Force the start frame, then let it go.
      void circle.offsetWidth;
      circle.style.transition = "";
      circle.style.transform = "";
      env.setTimeout(function () {
        if (state.root === root) setMode(state.mode);
      }, GROW_MS);
    }

    function measurable(node) {
      return Boolean(node && typeof node.getBoundingClientRect === "function" && node.style);
    }

    // --- the states -------------------------------------------------------------

    /** The ×, and only the ×: small for this tab's session. The small face brings it back. */
    function dismiss() {
      stopRinging();
      remember(true);
      resize("mini");
      if (opts.onDismissed) opts.onDismissed();
    }

    function reopen() {
      remember(false);
      if (!state.root) return build();
      if (state.mode === "mini") resize("rest");
      playPreview();
    }

    function openCall(greetingMs) {
      if (state.call || !state.root) return;
      stopRinging();
      var frame = doc.createElement("iframe");
      frame.src =
        opts.origin +
        "/embed/" +
        encodeURIComponent(opts.key) +
        "/video?autostart=1&bubble=1&o=" +
        encodeURIComponent(opts.hostOrigin) +
        // How long this page will be greeting for. In the URL rather than a
        // message because the frame is built in the same instant as the tap:
        // it has to know before its first render, and a message would race its
        // own listener into existence. A failure is a message, because by then
        // there is a frame to hear it.
        (greetingMs > 0 ? "&greeting=" + encodeURIComponent(String(greetingMs)) : "");
      frame.className = "bvb-frame";
      frame.title = "Video call with " + agent;
      // The microphone and sound, never the camera.
      frame.allow = "microphone; autoplay";
      frame.setAttribute("allowtransparency", "true");
      frame.setAttribute("data-belline-video", "call");
      state.call = frame;
      state.muted = false;

      resize("call", function () {
        state.root.insertBefore(frame, state.shut);
      });

      // The frame says when it is drawn; if it never does, show it anyway.
      state.readyTimer = env.setTimeout(function () {
        markReady(frame);
      }, 2500);
      state.onMessage = function (e) {
        if (!e || e.origin !== opts.origin || e.source !== frame.contentWindow) return;
        var msg = e.data;
        if (!msg || msg.source !== "belline-video") return;
        if (msg.type === "ready") markReady(frame);
        else if (msg.type === "size") {
          var h = Number(msg.height);
          if (h >= 120 && h <= 900 && frame.style) frame.style.height = Math.ceil(h) + "px";
        } else if (msg.type === "face") pausePreview();
        else if (msg.type === "muted") setMuted(msg.muted === true);
        else if (msg.type === "ended") closeCall({ fromFrame: true });
        else if (msg.type === "switch" && (msg.to === "chat" || msg.to === "voice")) {
          closeCall({ fromFrame: true });
          if (opts.onSwitch) opts.onSwitch(msg.to);
        }
      };
      if (env.addEventListener) env.addEventListener("message", state.onMessage);

      try {
        state.shut.focus();
      } catch (e) {
        /* focus is a nicety */
      }
      state.onKey = function (e) {
        if (e && e.key === "Escape") closeCall();
      };
      doc.addEventListener("keydown", state.onKey);
      armPip();
      if (opts.onCallOpened) opts.onCallOpened();
    }

    function markReady(frame) {
      if (state.call !== frame) return;
      if (frame.className.indexOf("is-ready") < 0) frame.className += " is-ready";
    }

    /**
     * End a call from the page: ask the frame to end its session, then take it
     * away and go back to the resting bubble, at full size. If the frame is
     * already gone or slow, its unload beacon ends the session on the server.
     */
    function closeCall(how) {
      var frame = state.call;
      if (!frame) return;
      state.call = null;
      // A call that ends during the greeting takes the greeting with it, and
      // leaves the circle the silent loop it was resting as.
      if (state.greeting) restoreSilentPreview();
      if (!(how && how.fromFrame)) {
        try {
          if (frame.contentWindow) frame.contentWindow.postMessage({ source: "belline-host", type: "end" }, opts.origin);
        } catch (e) {
          /* the beacon is the backstop */
        }
      }
      if (state.onKey) doc.removeEventListener("keydown", state.onKey);
      state.onKey = null;
      if (state.onMessage && env.removeEventListener) env.removeEventListener("message", state.onMessage);
      state.onMessage = null;
      if (state.readyTimer && env.clearTimeout) env.clearTimeout(state.readyTimer);
      state.readyTimer = null;
      disarmPip();
      leavePip(true);
      env.setTimeout(function () {
        frame.remove();
      }, END_GRACE_MS);
      // Out of sight and out of the layout at once; still there a moment to end its session.
      var hide = function () {
        frame.setAttribute("aria-hidden", "true");
        if (!frame.style) return;
        frame.style.visibility = "hidden";
        frame.style.position = "absolute";
        frame.style.pointerEvents = "none";
      };
      if (!state.root) hide();
      if (state.root) {
        resize("rest", hide);
        playPreview();
        try {
          // Without scrolling: a host may have floated the call away from where the bubble rests.
          state.circle.focus({ preventScroll: true });
        } catch (e) {
          /* focus is a nicety */
        }
      }
      if (opts.onCallClosed) opts.onCallClosed();
    }

    // --- picture in picture -----------------------------------------------------

    function scrollY() {
      return Number(env.pageYOffset || env.scrollY || 0);
    }

    /** During a call on a phone: scrolling on, or a tap anywhere else, tucks the call into a corner. */
    function armPip() {
      state.pipArmY = scrollY();
      state.onScroll = function () {
        if (!state.call || state.pip || !pipAllowed()) return;
        if (Math.abs(scrollY() - state.pipArmY) > PIP_SCROLL_PX) enterPip();
      };
      state.onOutside = function (e) {
        if (!state.call || state.pip || !pipAllowed()) return;
        var t = e && e.target;
        if (t && state.root && state.root.contains && state.root.contains(t)) return;
        enterPip();
      };
      if (env.addEventListener) env.addEventListener("scroll", state.onScroll, { passive: true });
      doc.addEventListener("pointerdown", state.onOutside, true);
    }

    function disarmPip() {
      if (state.onScroll && env.removeEventListener) env.removeEventListener("scroll", state.onScroll, { passive: true });
      if (state.onOutside) doc.removeEventListener("pointerdown", state.onOutside, true);
      state.onScroll = null;
      state.onOutside = null;
    }

    function buildPip() {
      if (state.pipFace) return;
      var face = el("button", "bvb-pipface");
      face.type = "button";
      face.setAttribute("aria-label", "Video call with " + agent + ", small. Tap to make it bigger");
      var bar = el("div", "bvb-pipbar");
      var mute = el("button", "bvb-pipbtn");
      mute.type = "button";
      mute.innerHTML = ICONS.mic;
      var end = el("button", "bvb-pipbtn bvb-pipend");
      end.type = "button";
      end.innerHTML = ICONS.end;
      end.setAttribute("aria-label", "End call");
      bar.appendChild(mute);
      bar.appendChild(end);
      state.root.appendChild(face);
      state.root.appendChild(bar);
      state.pipFace = face;
      state.pipMute = mute;
      setMuted(state.muted);

      mute.addEventListener("click", function () {
        showPipControls();
        var next = !state.muted;
        try {
          if (state.call && state.call.contentWindow) {
            state.call.contentWindow.postMessage({ source: "belline-host", type: "mute", muted: next }, opts.origin);
          }
        } catch (e) {
          /* the frame answers with its own state; nothing changes if it cannot hear */
        }
      });
      end.addEventListener("click", function () {
        closeCall();
      });

      // Drag, tap and hold on the face. A tap (or Enter) makes the call big again.
      var press = null;
      var suppressClick = false;
      face.addEventListener("pointerdown", function (e) {
        if (!state.pip || !measurable(state.root)) return;
        var box = state.root.getBoundingClientRect();
        press = { x: e.clientX, y: e.clientY, left: box.left, top: box.top, moved: false, held: false, id: e.pointerId };
        try {
          if (face.setPointerCapture) face.setPointerCapture(e.pointerId);
        } catch (err) {
          /* capture is a nicety */
        }
        press.timer = env.setTimeout(function () {
          if (press && !press.moved) {
            press.held = true;
            showPipControls();
          }
        }, PIP_HOLD_MS);
      });
      face.addEventListener("pointermove", function (e) {
        if (!press) return;
        var dx = e.clientX - press.x;
        var dy = e.clientY - press.y;
        if (!press.moved && Math.abs(dx) + Math.abs(dy) < 8) return;
        press.moved = true;
        state.root.className += state.root.className.indexOf("is-dragging") < 0 ? " is-dragging" : "";
        place(press.left + dx, press.top + dy);
      });
      var release = function () {
        if (!press) return;
        if (env.clearTimeout) env.clearTimeout(press.timer);
        if (press.moved) snap();
        suppressClick = press.moved || press.held;
        press = null;
        state.root.className = String(state.root.className).replace(/\s*\bis-dragging\b/g, "");
      };
      face.addEventListener("pointerup", release);
      face.addEventListener("pointercancel", release);
      face.addEventListener("click", function () {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        leavePip();
      });
    }

    function viewport() {
      var docEl = doc.documentElement || {};
      return { w: Number(env.innerWidth || docEl.clientWidth || 0), h: Number(env.innerHeight || docEl.clientHeight || 0) };
    }

    /** Keep the small face on screen, and room for its controls under it. */
    function place(left, top) {
      var v = viewport();
      var size = measurable(state.circle) ? state.circle.getBoundingClientRect().width || 96 : 96;
      var x = Math.max(PIP_MARGIN, Math.min(left, v.w - size - PIP_MARGIN));
      var y = Math.max(PIP_MARGIN, Math.min(top, v.h - size - PIP_MARGIN - 44));
      var s = state.root.style;
      s.left = Math.round(x) + "px";
      s.top = Math.round(y) + "px";
      s.right = "auto";
      s.bottom = "auto";
    }

    /** Let go: to the nearer side. */
    function snap() {
      if (!measurable(state.root)) return;
      var v = viewport();
      var box = state.root.getBoundingClientRect();
      var left = box.left + box.width / 2 < v.w / 2 ? PIP_MARGIN : v.w - box.width - PIP_MARGIN;
      place(left, box.top);
    }

    function showPipControls() {
      if (!state.root) return;
      if (state.root.className.indexOf("is-pipctl") < 0) state.root.className += " is-pipctl";
      if (state.pipTimer && env.clearTimeout) env.clearTimeout(state.pipTimer);
      state.pipTimer = env.setTimeout(function () {
        state.pipTimer = null;
        if (state.root) setMode(state.mode);
      }, PIP_CONTROLS_MS);
    }

    function enterPip() {
      if (!state.call || state.pip || !state.root) return;
      buildPip();
      state.pip = true;
      setMode("call");
      if (opts.onPip) opts.onPip(true);
    }

    function leavePip(quiet) {
      if (!state.pip) return;
      state.pip = false;
      if (state.pipTimer && env.clearTimeout) env.clearTimeout(state.pipTimer);
      state.pipTimer = null;
      if (state.root && state.root.style) {
        state.root.style.left = "";
        state.root.style.top = "";
        state.root.style.right = "";
        state.root.style.bottom = "";
      }
      state.pipArmY = scrollY();
      setMode(state.mode === "call" && state.call ? "call" : state.mode);
      // Before focus moves: a host may first put the grown call where the visitor is (belline.ai floats it).
      if (opts.onPip) opts.onPip(false);
      if (!quiet) {
        try {
          state.shut.focus({ preventScroll: true });
        } catch (e) {
          /* focus is a nicety */
        }
      }
    }

    function setMuted(muted) {
      state.muted = Boolean(muted);
      if (!state.pipMute) return;
      state.pipMute.setAttribute("aria-pressed", state.muted ? "true" : "false");
      state.pipMute.setAttribute("aria-label", state.muted ? "Unmute microphone" : "Mute microphone");
    }

    build();

    return {
      /** Bring the resting bubble back from its small face. */
      reopen: reopen,
      /**
       * Open the call from the page's own button (site.js's hero).
       *
       * It speaks the greeting like any other tap: the caller is inside a real
       * click handler, which is the only place the sound can be started.
       */
      openCall: function () {
        openCall(speakGreeting());
      },
      closeCall: closeCall,
      dismiss: dismiss,
      /** Tuck a call into its corner, or grow it back (a phone does this by itself). */
      pip: function (on) {
        if (on) enterPip();
        else leavePip();
      },
      /** Hide the whole thing while a page opens something else in its place. */
      setHidden: function (hidden) {
        if (state.root) state.root.hidden = Boolean(hidden);
      },
      state: function () {
        return {
          bubble: state.mode === "rest",
          mini: state.mode === "mini",
          call: Boolean(state.call),
          pip: Boolean(state.call && state.pip),
          ringing: state.ringing,
          hidden: Boolean(state.root && state.root.hidden),
          dismissed: dismissed(),
        };
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
