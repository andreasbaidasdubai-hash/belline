/**
 * The video receptionist's round bubble, for a venue's website and belline.ai.
 *
 * Loaded by embed.js and site.js only when the venue's config says
 * `video: true`, after the page has painted. It never loads the Daily SDK,
 * never asks for the microphone and never creates a session. All of that
 * happens inside the call frame, and only after the visitor taps.
 *
 * One round thing, in three sizes:
 *
 *   **Resting.** The face (the venue's muted greeting clip, a poster or a
 *   lettered placeholder) with "AI concierge" on its top edge, a × on its
 *   shoulder, one primary button, "Talk to Belle", and beside it one small
 *   secondary button, "Other ways to reach us", which opens a compact menu of
 *   whatever else the page offers (chat, WhatsApp, a voice call). On a wide
 *   screen a short pill, "Hi, I'm Belle — tap to talk", sits above the face,
 *   inside the bubble's own column; on a narrow one it is dropped, so it never
 *   covers the page's buttons.
 *
 *   **In a call.** Tapping the face or "Talk to Belle" grows the same circle in
 *   place (instantly under reduced motion) and lays the call frame
 *   (/embed/<key>/video?autostart=1&bubble=1) over it: a transparent page
 *   whose own circle, pills and two controls line up with this one. No panel,
 *   no header, no rectangle. The face's muted preview keeps playing in the
 *   growing circle while the session is made, and the live face fades in over
 *   it. The live session starts inside the frame.
 *
 *   **Small.** The × on a resting bubble shrinks it to a small face beside the
 *   secondary button for the rest of the browser session. Tapping the face
 *   brings the bubble back. Closing during a call ends the call first: the
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

  var BLUE = "var(--bl-blue,#0071E3)";
  var INK = "var(--bl-ink-900,#1D1D1F)";
  var GREY = "var(--bl-text-2,#6E6E73)";
  var SURFACE = "var(--bl-surface,#F5F5F7)";
  var WHITE = "var(--bl-ground,#FFFFFF)";
  var LINE = "var(--bl-blue-line,#D2D2D7)";
  var FLOAT = "var(--bl-elev-float,0 12px 32px -16px rgba(0,0,0,.3))";

  var CSS =
    // The current circle is one variable, so the pills and the × follow it through every size.
    ".bvb{--bvb-cur:var(--bvb-size,200px);--bvb-call:min(320px,calc(100vw - 48px),calc(100dvh - 250px));" +
    "position:relative;display:block;width:var(--bvb-cur);flex:none;box-sizing:border-box;" +
    "font:500 13px/1.35 var(--bl-font-text,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif);" +
    "color:" + INK + ";-webkit-font-smoothing:antialiased;text-align:left}" +
    ".bvb *{box-sizing:border-box}" +
    ".bvb[hidden]{display:none}.bvb.bvb-fixed{position:fixed;z-index:41}" +
    ".bvb.is-call{--bvb-cur:max(180px,var(--bvb-call))}" +
    ".bvb.is-mini{--bvb-cur:56px}" +
    "@media (max-width:520px){.bvb{--bvb-call:min(252px,calc(100vw - 40px),calc(100dvh - 230px))}}" +
    // The face.
    ".bvb-circle{position:relative;display:block;width:var(--bvb-cur);height:var(--bvb-cur);padding:0;margin:0;" +
    "border:0;border-radius:50%;overflow:hidden;cursor:pointer;background:var(--bl-navy,#1D1D1F);transform-origin:0 0;" +
    "box-shadow:0 0 0 3px " + WHITE + ",0 0 0 4px " + LINE + "," + FLOAT + "}" +
    ".bvb.is-call .bvb-circle{position:absolute;top:0;right:0;cursor:default}" +
    ".bvb.bvb-left.is-call .bvb-circle{right:auto;left:0}" +
    ".bvb.is-growing .bvb-circle{transition:transform " + GROW_MS + "ms cubic-bezier(.2,.8,.2,1)}" +
    ".bvb-circle:focus-visible,.bvb-talk:focus-visible,.bvb-shut:focus-visible,.bvb-more:focus-visible,.bvb-item:focus-visible" +
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
    ".bvb.is-call .bvb-caption,.bvb.is-mini .bvb-caption,.bvb.is-menu .bvb-caption{display:none}" +
    "@media (max-width:900px){.bvb-caption{display:none}}" +
    // The one primary button.
    ".bvb-row{position:relative;margin-top:12px}" +
    ".bvb-mock~.bvb-row{margin-top:18px}" +
    ".bvb-talk{display:flex;align-items:center;justify-content:center;width:100%;min-height:44px;padding:0 12px;margin:0;" +
    "border:0;border-radius:999px;cursor:pointer;font:inherit;font-weight:600;font-size:14px;white-space:nowrap;" +
    "background:" + BLUE + ";color:#FFFFFF;box-shadow:" + FLOAT + "}" +
    ".bvb-talk:hover{background:var(--bl-blue-hover,#006EDB)}" +
    // The one secondary button, beside it on the inner side, and its menu above.
    ".bvb-more{position:absolute;bottom:0;right:calc(100% + 10px);width:44px;height:44px;padding:0;margin:0;display:grid;place-items:center;" +
    "border-radius:50%;border:1px solid " + LINE + ";background:" + WHITE + ";color:" + BLUE + ";cursor:pointer;box-shadow:" + FLOAT + "}" +
    ".bvb-more svg{width:22px;height:22px;display:block}" +
    ".bvb-more:hover,.bvb-more[aria-expanded=true]{background:" + SURFACE + "}" +
    ".bvb.bvb-left .bvb-more{right:auto;left:calc(100% + 10px)}" +
    ".bvb-menu{position:absolute;right:calc(100% + 10px);bottom:54px;min-width:200px;margin:0;padding:6px;list-style:none;z-index:4;" +
    "background:" + WHITE + ";border:1px solid " + LINE + ";border-radius:16px;box-shadow:0 18px 40px -18px rgba(0,0,0,.35)}" +
    ".bvb.bvb-left .bvb-menu{right:auto;left:calc(100% + 10px)}" +
    ".bvb-menu[hidden]{display:none}" +
    ".bvb-menu-h{margin:0;padding:6px 10px 4px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:" + GREY + "}" +
    ".bvb-item{display:flex;align-items:center;gap:12px;width:100%;min-height:44px;padding:0 12px;margin:0;border:0;border-radius:10px;" +
    "background:transparent;color:" + INK + ";font:inherit;font-size:14px;font-weight:500;text-align:left;text-decoration:none;cursor:pointer;white-space:nowrap}" +
    ".bvb-item:hover{background:" + SURFACE + "}" +
    ".bvb-item svg{width:20px;height:20px;flex:none;color:" + BLUE + "}" +
    // Small: the face alone, the secondary button beside it.
    ".bvb.is-mini .bvb-row{position:absolute;margin:0;bottom:6px;left:0;width:0;height:44px}" +
    ".bvb.bvb-left.is-mini .bvb-row{left:auto;right:0}" +
    ".bvb.is-mini .bvb-talk,.bvb.is-call .bvb-row{display:none}" +
    ".bvb.is-mini .bvb-menu{bottom:54px}" +
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
    "@media (prefers-reduced-motion:reduce){.bvb-ph span{animation:none}" +
    ".bvb.is-growing .bvb-circle,.bvb-frame,.bvb-tags,.bvb-shut{transition:none}}";

  // Icons, drawn in the same hand as embed.js's.
  var ICON_OTHER =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M3 11.2C3 6.9 7.03 3.5 12 3.5s9 3.4 9 7.7c0 4.3-4.03 7.7-9 7.7a11 11 0 0 1-2.4-.26L5.4 20.5l.5-3.2A7.7 7.7 0 0 1 3 11.2Z" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
    '<circle cx="8.2" cy="11.2" r="1.15" fill="currentColor"/><circle cx="12" cy="11.2" r="1.15" fill="currentColor"/>' +
    '<circle cx="15.8" cy="11.2" r="1.15" fill="currentColor"/></svg>';
  var ICONS = {
    chat:
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M3 11.2C3 6.9 7.03 3.5 12 3.5s9 3.4 9 7.7c0 4.3-4.03 7.7-9 7.7a11 11 0 0 1-2.4-.26L5.4 20.5l.5-3.2A7.7 7.7 0 0 1 3 11.2Z" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    whatsapp:
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.9L3.6 20.4l4.1-1.1A8.5 8.5 0 1 0 12 3.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<path d="M9.2 8.6c.2-.4.4-.4.6-.4h.5c.2 0 .4 0 .5.4l.7 1.6c.1.2 0 .4-.1.5l-.5.6c-.1.1-.1.3 0 .4a6 6 0 0 0 2.6 2.5c.2.1.3.1.4 0l.6-.7c.1-.2.3-.2.5-.1l1.6.7c.2.1.4.2.4.4 0 .3 0 1-.4 1.4-.5.5-1.2.7-1.8.6a7.9 7.9 0 0 1-5.7-5.6c-.1-.6 0-1.3.6-1.8Z" fill="currentColor"/></svg>',
    voice:
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M6.6 3.8h2.6l1.3 4.1-2 1.4a11.5 11.5 0 0 0 6.2 6.2l1.4-2 4.1 1.3v2.6a2 2 0 0 1-2.2 2A16.6 16.6 0 0 1 4.6 6a2 2 0 0 1 2-2.2Z" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  };

  function mount(opts) {
    var env = opts.env;
    var doc = env.document;
    var storage = env.sessionStorage;
    var cfg = opts.config || {};
    var agent = cfg.agentName || "Belle";
    var words = opts.strings || {};
    var otherLabel = words.otherWays || "Other ways to reach us";
    var state = {
      root: null,
      circle: null,
      menu: null,
      more: null,
      shut: null,
      call: null,
      video: null,
      mode: null,
      onKey: null,
      onMessage: null,
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

    function others() {
      var list = typeof opts.others === "function" ? opts.others() : opts.others;
      return (list || []).filter(function (o) {
        return o && o.label && typeof o.run === "function";
      });
    }

    function setMode(mode) {
      state.mode = mode;
      if (!state.root) return;
      // The page's own classes on the bubble (site.js adds one) are kept.
      var theirs = String(state.root.className || "")
        .split(" ")
        .filter(function (c) {
          return c && !/^(bvb|bvb-fixed|bvb-left|is-call|is-mini|is-menu|is-growing)$/.test(c);
        });
      state.root.className =
        (theirs.length ? theirs.join(" ") + " " : "") +
        "bvb" +
        (opts.fixed ? " bvb-fixed" : "") +
        (opts.side === "left" ? " bvb-left" : "") +
        (mode === "call" ? " is-call" : mode === "mini" ? " is-mini" : "") +
        (state.menu && !state.menu.hidden ? " is-menu" : "");
      state.root.setAttribute("data-state", mode);
      if (state.circle) {
        state.circle.setAttribute(
          "aria-label",
          mode === "call"
            ? agent + ", AI concierge, on a video call"
            : mode === "mini"
              ? "Video call with " + agent + ", the AI concierge"
              : "Talk to " + agent + ", the AI concierge, on a video call",
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
        else if (state.mode === "rest") openCall();
      });

      var tags = el("span", "bvb-tags");
      tags.appendChild(el("span", "bvb-ai", "AI concierge"));

      var caption = el("p", "bvb-caption", words.caption || "Hi, I'm " + agent + " — tap to talk");
      caption.setAttribute("aria-hidden", "true");

      var row = el("div", "bvb-row");
      var talk = el("button", "bvb-talk", "Talk to " + agent);
      talk.type = "button";
      talk.addEventListener("click", openCall);
      row.appendChild(talk);

      if (others().length) {
        var more = el("button", "bvb-more");
        more.type = "button";
        more.innerHTML = ICON_OTHER;
        more.setAttribute("aria-label", otherLabel);
        more.setAttribute("title", otherLabel);
        more.setAttribute("aria-expanded", "false");
        more.setAttribute("aria-haspopup", "true");
        more.addEventListener("click", function (e) {
          if (e && e.stopPropagation) e.stopPropagation();
          toggleMenu();
        });
        var menu = el("div", "bvb-menu");
        menu.hidden = true;
        menu.setAttribute("role", "group");
        menu.setAttribute("aria-label", otherLabel);
        row.appendChild(more);
        row.appendChild(menu);
        state.more = more;
        state.menu = menu;
      }

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
      state.shut = shut;
      setMode(dismissed() ? "mini" : "rest");
      setShutLabel();
      opts.place(root);
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

    function afterPaint(fn) {
      var raf = env.requestAnimationFrame;
      var later = env.setTimeout;
      if (raf) raf(function () { later(fn, 0); });
      else later(fn, 0);
    }

    // --- the menu -----------------------------------------------------------

    function fillMenu() {
      var menu = state.menu;
      while (menu.children && menu.children.length) menu.children[0].remove();
      menu.appendChild(el("p", "bvb-menu-h", otherLabel));
      others().forEach(function (o) {
        var item = el("button", "bvb-item");
        item.type = "button";
        item.setAttribute("data-kind", o.kind || "");
        item.innerHTML = (ICONS[o.kind] || ICONS.chat) + "<span></span>";
        var label = item.querySelector ? item.querySelector("span") : null;
        if (label) label.textContent = o.label;
        else item.textContent = o.label;
        item.addEventListener("click", function () {
          closeMenu();
          o.run();
        });
        menu.appendChild(item);
      });
    }

    function toggleMenu() {
      if (!state.menu) return;
      if (state.menu.hidden) openMenu();
      else closeMenu(true);
    }

    function openMenu() {
      var list = others();
      if (list.length === 1) return list[0].run();
      fillMenu();
      state.menu.hidden = false;
      state.more.setAttribute("aria-expanded", "true");
      setMode(state.mode);
      state.onOutside = function (e) {
        var t = e && e.target;
        if (t && state.root && state.root.contains && state.root.contains(t)) return;
        closeMenu();
      };
      doc.addEventListener("click", state.onOutside);
      state.onMenuKey = function (e) {
        if (e && e.key === "Escape") closeMenu(true);
      };
      doc.addEventListener("keydown", state.onMenuKey);
      var first = state.menu.children[1];
      try {
        if (first && first.focus) first.focus();
      } catch (e) {
        /* focus is a nicety */
      }
    }

    function closeMenu(refocus) {
      if (!state.menu || state.menu.hidden) return;
      state.menu.hidden = true;
      state.more.setAttribute("aria-expanded", "false");
      if (state.onOutside) doc.removeEventListener("click", state.onOutside);
      if (state.onMenuKey) doc.removeEventListener("keydown", state.onMenuKey);
      state.onOutside = null;
      state.onMenuKey = null;
      setMode(state.mode);
      if (refocus) {
        try {
          state.more.focus();
        } catch (e) {
          /* focus is a nicety */
        }
      }
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
      closeMenu();
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

    // --- the three states -----------------------------------------------------

    /** The ×: small for this browser session. The small face brings it back. */
    function dismiss() {
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

    function openCall() {
      if (state.call || !state.root) return;
      var frame = doc.createElement("iframe");
      frame.src =
        opts.origin +
        "/embed/" +
        encodeURIComponent(opts.key) +
        "/video?autostart=1&bubble=1&o=" +
        encodeURIComponent(opts.hostOrigin);
      frame.className = "bvb-frame";
      frame.title = "Video call with " + agent;
      // The microphone and sound, never the camera.
      frame.allow = "microphone; autoplay";
      frame.setAttribute("allowtransparency", "true");
      frame.setAttribute("data-belline-video", "call");
      state.call = frame;

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
      if (opts.onCallOpened) opts.onCallOpened();
    }

    function markReady(frame) {
      if (state.call !== frame) return;
      if (frame.className.indexOf("is-ready") < 0) frame.className += " is-ready";
    }

    /**
     * End a call from the page: ask the frame to end its session, then take it
     * away and shrink back to the resting bubble. If the frame is already gone
     * or slow, its unload beacon ends the session on the server anyway.
     */
    function closeCall(how) {
      var frame = state.call;
      if (!frame) return;
      state.call = null;
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
      env.setTimeout(function () {
        frame.remove();
      }, END_GRACE_MS);
      // Closing a call is not a dismissal of the greeting, but it does not
      // replay it on the next page either: the visitor has met Belle.
      remember(true);
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
          state.circle.focus();
        } catch (e) {
          /* focus is a nicety */
        }
      }
      if (opts.onCallClosed) opts.onCallClosed();
    }

    build();

    return {
      /** Bring the resting bubble back from its small face. */
      reopen: reopen,
      openCall: openCall,
      closeCall: closeCall,
      dismiss: dismiss,
      /** Hide the whole thing while a page opens something else in its place. */
      setHidden: function (hidden) {
        if (state.root) state.root.hidden = Boolean(hidden);
      },
      state: function () {
        return {
          bubble: state.mode === "rest",
          mini: state.mode === "mini",
          call: Boolean(state.call),
          menu: Boolean(state.menu && !state.menu.hidden),
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
