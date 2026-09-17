/**
 * Belline, on your own website.
 *
 *   <script src="https://app.belline.ai/embed.js" data-belline="be_xxx" async></script>
 *
 * One line, no build step, no package to install. The most common thing on the
 * other end of this is a Squarespace footer box, and anything that needs more
 * than a paste does not get installed.
 *
 * What it does: puts a button in the corner of the page. Tapping it opens a
 * panel in which the visitor reaches that venue's own receptionist — the same
 * agent, the same diary, the same refusals as the telephone.
 *
 * Two ways in, and the venue chooses which:
 *
 *   data-mode="voice"  a bell. The visitor is talking, out loud, in a second.
 *   data-mode="chat"   a speech bubble. They type.
 *   data-mode="both"   both buttons, chat above the bell.
 *
 * Unset means "voice", which is what every site carrying this script before
 * chat existed already had. A feature shipping must not change somebody's live
 * website on its own.
 *
 * The attribute picks what to *show*. It cannot switch on something the venue
 * has switched off — that lives in the venue's own settings, and the panel says
 * so plainly if the two disagree. Otherwise the entitlement would sit in a
 * customer's HTML, where anybody who can view source can edit it.
 *
 * Deliberately small and deliberately defensive. It runs on somebody else's
 * page, beside somebody else's scripts, and it must not break their site if
 * anything here goes wrong.
 */
(function () {
  "use strict";

  var script = document.currentScript;
  if (!script) return;

  var key = script.getAttribute("data-belline");
  if (!key) {
    // Their page, their console. Say what is wrong rather than failing silently.
    console.warn("[belline] no data-belline key on the script tag — nothing to open.");
    return;
  }

  // Derived from where this file was served, so a staging deployment embeds
  // itself rather than production.
  var origin = new URL(script.src, location.href).origin;
  var side = script.getAttribute("data-side") === "left" ? "left" : "right";

  var attrMode = script.hasAttribute("data-mode");
  var mode = (script.getAttribute("data-mode") || "voice").toLowerCase();
  if (mode !== "chat" && mode !== "both") mode = "voice";

  // The words on the buttons. An attribute on the tag is page-specific and
  // wins; otherwise the venue's own choice from the dashboard arrives a moment
  // later (see `dress`), and until then these.
  var voiceLabel = script.getAttribute("data-label") || "Talk to us";
  var chatLabel = script.getAttribute("data-chat-label") || "Chat with us";
  var whatsappLabel = script.getAttribute("data-whatsapp-label") || "WhatsApp us";
  // The widget's own words, replaced by the venue's language from its config
  // (customer-copy.ts `embed.close_*`) once that arrives.
  var STRINGS = { closeChat: "Close chat", closeCall: "Close call" };
  var attrSide = script.hasAttribute("data-side");
  var attrVoice = script.hasAttribute("data-label");
  var attrChat = script.hasAttribute("data-chat-label");

  // One widget per page, whatever a page builder does with duplicate blocks.
  if (window.__bellineEmbed) return;
  window.__bellineEmbed = true;

  var css =
    ".belline-dock{position:fixed;bottom:24px;right:24px;z-index:2147483000;" +
    "display:flex;flex-direction:column;align-items:flex-end;gap:10px;" +
    "--belline-accent:#0071E3;--belline-accent-text:#FFFFFF;--belline-accent-mark:#FFFFFF}" +
    ".belline-dock.belline-left{right:auto;left:24px;align-items:flex-start}" +
    ".belline-fab{display:inline-flex;align-items:center;gap:10px;text-decoration:none;" +
    "padding:14px 22px 14px 18px;border:0;border-radius:999px;" +
    "background:var(--belline-accent);color:var(--belline-accent-text);" +
    "cursor:pointer;font:500 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
    "box-shadow:0 14px 34px -14px rgba(0,0,0,.5);transition:transform .16s ease}" +
    ".belline-fab:hover{transform:translateY(-2px)}" +
    // Belline's focus ring: blue, 2px, offset 3px so it sits on the host page (4.70:1 on white).
    ".belline-fab:focus-visible,.belline-shut:focus-visible{outline:2px solid #0071E3;outline-offset:3px}" +
    ".belline-fab svg{width:24px;height:24px;color:var(--belline-accent-mark);display:block;flex:none}" +
    // The second and third buttons are the quieter ones: paper rather than
    // the accent, so the set reads as one offer with a primary in it.
    ".belline-fab.belline-second{background:#FFFFFF;color:#1D1D1F;border:1px solid #D2D2D7;" +
    "box-shadow:0 10px 26px -14px rgba(0,0,0,.42)}" +
    ".belline-fab.belline-second svg{color:#0071E3}" +
    // Round: the mark alone, as on a phone, at every width.
    ".belline-dock.belline-round .belline-fab{padding:0;width:58px;height:58px;justify-content:center}" +
    ".belline-dock.belline-round .belline-fab span:not(.belline-logo){display:none}" +
    ".belline-panel{position:fixed;bottom:24px;right:24px;z-index:2147483001;" +
    "width:380px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 48px);" +
    "border:0;border-radius:14px;overflow:hidden;background:#1D1D1F;" +
    "box-shadow:0 24px 60px -20px rgba(0,0,0,.55)}" +
    ".belline-panel.belline-left{right:auto;left:24px}" +
    ".belline-shut{position:fixed;z-index:2147483002;width:32px;height:32px;border:0;" +
    "border-radius:999px;background:rgba(255,255,255,.14);color:#FFFFFF;cursor:pointer;" +
    "font:16px/1 sans-serif;display:grid;place-items:center}" +
    "@media (max-width:520px){.belline-panel,.belline-panel.belline-left{inset:0;width:100%;height:100%;" +
    "max-width:none;max-height:none;border-radius:0}" +
    ".belline-dock{bottom:18px;right:18px}.belline-dock.belline-left{left:18px}" +
    ".belline-fab{padding:0;width:58px;height:58px;justify-content:center}" +
    ".belline-fab span:not(.belline-logo){display:none}}" +
    // The venue's logo in place of the mark: always in a white circle, with
    // room around it, so a dark logo on a dark accent (or a white one on
    // white) still reads. Contained, never cropped — a wordmark stays whole.
    ".belline-logo{display:block;flex:none;width:30px;height:30px;box-sizing:border-box;padding:3px;" +
    "border-radius:999px;background:#FFFFFF;box-shadow:0 0 0 1px rgba(29,29,31,.1);overflow:hidden}" +
    ".belline-logo img{display:block;width:100%;height:100%;object-fit:contain;border-radius:999px}" +
    ".belline-fab.belline-has-logo{padding-top:11px;padding-bottom:11px;padding-left:12px}" +
    ".belline-dock.belline-round .belline-logo{width:46px;height:46px;padding:5px}" +
    "@media (max-width:520px){.belline-fab.belline-has-logo{padding:0}" +
    ".belline-fab .belline-logo{width:46px;height:46px;padding:5px}}" +
    // Ringing, as the bell on belline.ai rings (site.css bell-shake, bell-nudge,
    // bell-ring, value for value): the mark swings, the button nudges, a ring
    // runs outwards. Only while the dock carries .belline-ringing, which the
    // script adds for a few seconds at a time — see `ring` below.
    ".belline-fab.belline-main{position:relative;isolation:isolate}" +
    ".belline-fab.belline-main::after{content:'';position:absolute;inset:0;border-radius:inherit;" +
    "border:2px solid var(--belline-accent);pointer-events:none;opacity:0;z-index:-1}" +
    ".belline-ringing .belline-fab.belline-main{animation:belline-nudge 1.5s ease-in-out infinite}" +
    ".belline-ringing .belline-fab.belline-main svg,.belline-ringing .belline-fab.belline-main .belline-logo" +
    "{animation:belline-shake 1.5s ease-in-out infinite}" +
    ".belline-ringing .belline-fab.belline-main::after{animation:belline-ring 1.5s ease-out infinite}" +
    "@keyframes belline-shake{0%,27%,100%{transform:rotate(0deg)}2%{transform:rotate(-22deg)}" +
    "4%{transform:rotate(22deg)}6%{transform:rotate(-19deg)}8%{transform:rotate(19deg)}" +
    "10%{transform:rotate(-15deg)}12%{transform:rotate(15deg)}14%{transform:rotate(-11deg)}" +
    "16%{transform:rotate(11deg)}18%{transform:rotate(-8deg)}20%{transform:rotate(8deg)}" +
    "22%{transform:rotate(-4deg)}24%{transform:rotate(4deg)}}" +
    "@keyframes belline-nudge{0%,14%,100%{transform:translateY(0) rotate(0deg)}" +
    "3%{transform:translateY(-2px) rotate(-1.6deg)}7%{transform:translateY(-2px) rotate(1.6deg)}" +
    "11%{transform:translateY(-1px) rotate(-.8deg)}}" +
    "@keyframes belline-ring{0%{transform:scale(1);opacity:.55}55%{transform:scale(1.28);opacity:0}" +
    "100%{transform:scale(1.28);opacity:0}}" +
    // The script never starts it under reduced motion; this is the belt for
    // a preference switched on while a ring is already running.
    "@media (prefers-reduced-motion:reduce){.belline-fab{transition:none}" +
    ".belline-ringing .belline-fab.belline-main,.belline-ringing .belline-fab.belline-main svg," +
    ".belline-ringing .belline-fab.belline-main .belline-logo,.belline-ringing .belline-fab.belline-main::after" +
    "{animation:none!important}}" +
    // "Also speaks Deutsch": a small line under the buttons, in the venue's main language.
    ".belline-notice{font:12px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1D1D1F;" +
    "background:rgba(255,255,255,.92);padding:3px 9px;border-radius:999px;unicode-bidi:plaintext}";

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var BELL =
    '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">' +
    '<circle cx="24" cy="9.5" r="3.5" fill="currentColor"/>' +
    '<path d="M9 31.5a15 15 0 0 1 30 0Z" fill="currentColor"/>' +
    '<rect x="5" y="35" width="38" height="5.5" rx="2.75" fill="currentColor"/></svg>';

  // The bell again, inside a speech bubble. The same mark in both places is
  // what makes the pair legible as one product; the bubble is what makes it
  // obvious at a glance which of the two is for typing.
  var BUBBLE =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M3 11.2C3 6.9 7.03 3.5 12 3.5s9 3.4 9 7.7c0 4.3-4.03 7.7-9 7.7a11 11 0 0 1-2.4-.26' +
    'L5.4 20.5l.5-3.2A7.7 7.7 0 0 1 3 11.2Z" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linejoin="round"/>' +
    '<circle cx="12" cy="7.4" r="1.05" fill="currentColor"/>' +
    '<path d="M8.7 13.1a3.3 3.3 0 0 1 6.6 0Z" fill="currentColor"/>' +
    '<rect x="7.8" y="13.8" width="8.4" height="1.35" rx=".68" fill="currentColor"/></svg>';

  // WhatsApp, drawn in the same hand as the bell and the bubble.
  var WA =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.9L3.6 20.4l4.1-1.1A8.5 8.5 0 1 0 12 3.5Z" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<path d="M9.2 8.6c.2-.4.4-.4.6-.4h.5c.2 0 .4 0 .5.4l.7 1.6c.1.2 0 .4-.1.5l-.5.6c-.1.1-.1.3 0 .4' +
    'a6 6 0 0 0 2.6 2.5c.2.1.3.1.4 0l.6-.7c.1-.2.3-.2.5-.1l1.6.7c.2.1.4.2.4.4 0 .3 0 1-.4 1.4' +
    '-.5.5-1.2.7-1.8.6a7.9 7.9 0 0 1-5.7-5.6c-.1-.6 0-1.3.6-1.8Z" fill="currentColor"/></svg>';

  var dock = document.createElement("div");
  dock.className = "belline-dock" + (side === "left" ? " belline-left" : "");

  var panel = null;
  var shut = null;
  var reopen = null;
  var fabs = {};

  function fabFor(kind, label, icon, second) {
    var fab = document.createElement("button");
    fab.type = "button";
    // The filled one is "main": it is the button that may carry the logo and
    // the one that rings. There is exactly one per mode.
    fab.className = "belline-fab" + (second ? " belline-second" : " belline-main");
    fab.setAttribute("aria-label", label);
    fab.innerHTML = icon + "<span>" + escapeHtml(label) + "</span>";
    fab.addEventListener("click", function () {
      reopen = fab;
      open(kind, label);
    });
    fabs[kind] = fab;
    return fab;
  }

  // Chat first in the column, so on `both` it sits above the bell. The bell
  // stays the filled button: it is the thing this product does that a chat
  // widget does not.
  function buildMode(m) {
    ["voice", "chat"].forEach(function (k) {
      if (fabs[k]) {
        fabs[k].remove();
        delete fabs[k];
      }
    });
    if (m === "chat") {
      dock.appendChild(fabFor("chat", chatLabel, BUBBLE, false));
    } else if (m === "both") {
      dock.appendChild(fabFor("chat", chatLabel, BUBBLE, true));
      dock.appendChild(fabFor("voice", voiceLabel, BELL, false));
    } else {
      dock.appendChild(fabFor("voice", voiceLabel, BELL, false));
    }
    markMain();
  }

  /**
   * The venue's logo on the main button, when it chose that and has one.
   *
   * Only ever a path under /api/logo/ on Belline's own origin — a logo Belline
   * checked and serves with its own headers — never a URL from anywhere else,
   * so the settings cannot make somebody's website load a stranger's file.
   * The image is decorative: the button already says what it does in its
   * aria-label. If it fails to load, the mark it replaced comes back.
   */
  var logoPath = null;

  function markMain() {
    var kind = mode === "chat" ? "chat" : "voice";
    var fab = fabs[kind];
    if (!fab || !logoPath || fab.querySelector(".belline-logo")) return;
    var mark = fab.querySelector("svg");
    if (!mark) return;
    var holder = document.createElement("span");
    holder.className = "belline-logo";
    holder.setAttribute("aria-hidden", "true");
    var img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", function () {
      if (holder.parentNode) holder.parentNode.replaceChild(mark, holder);
      fab.classList.remove("belline-has-logo");
    });
    img.src = origin + logoPath;
    holder.appendChild(img);
    fab.replaceChild(holder, mark);
    fab.classList.add("belline-has-logo");
  }

  buildMode(mode);

  /**
   * The venue's own choices, fetched after the buttons are on screen.
   *
   * Words, colour, shape, corner, and a WhatsApp button when the venue has a
   * number. Applied on top of the defaults rather than waited for, so a slow
   * or failed fetch costs the venue its colour for a second, never its widget.
   * An attribute on the tag is page-specific and keeps precedence.
   */
  function relabel(kind, label) {
    var fab = fabs[kind];
    if (!fab || !label) return;
    fab.setAttribute("aria-label", label);
    var span = fab.querySelector("span:not(.belline-logo)");
    if (span) span.textContent = label;
  }

  function dress(cfg) {
    if (!cfg || typeof cfg !== "object") return;
    // The business has not gone live yet. Installed is enough to be detected;
    // visitors see nothing until it is switched on.
    if (cfg.live === false) {
      dock.remove();
      return;
    }
    // No attribute on the tag means the dashboard decides what is offered —
    // so switching chat on in Belline reaches the site without a re-paste.
    if (!attrMode && (cfg.mode === "voice" || cfg.mode === "chat" || cfg.mode === "both") && cfg.mode !== mode) {
      mode = cfg.mode;
      buildMode(mode);
    }
    if (cfg.buttonMark === "logo" && typeof cfg.logoUrl === "string" && /^\/api\/logo\/lg_[0-9a-f]{24}$/.test(cfg.logoUrl)) {
      logoPath = cfg.logoUrl;
      markMain();
    }
    if (cfg.ring === true) ring();
    if (!attrVoice) relabel("voice", cfg.voiceLabel);
    if (!attrChat) relabel("chat", cfg.chatLabel);
    if (cfg.strings && typeof cfg.strings === "object") {
      if (cfg.strings.closeChat) STRINGS.closeChat = String(cfg.strings.closeChat);
      if (cfg.strings.closeCall) STRINGS.closeCall = String(cfg.strings.closeCall);
    }
    if (cfg.notice && !dock.querySelector(".belline-notice")) {
      var notice = document.createElement("div");
      notice.className = "belline-notice";
      notice.textContent = String(cfg.notice);
      if (cfg.lang) notice.lang = String(cfg.lang);
      notice.dir = cfg.dir === "rtl" ? "rtl" : "auto";
      dock.appendChild(notice);
    }
    if (cfg.accent && cfg.accentText) {
      dock.style.setProperty("--belline-accent", cfg.accent);
      dock.style.setProperty("--belline-accent-text", cfg.accentText);
      dock.style.setProperty("--belline-accent-mark", cfg.accentMark || "#FFFFFF");
    }
    if (cfg.shape === "round") dock.classList.add("belline-round");
    if (!attrSide && cfg.corner === "left") {
      dock.classList.add("belline-left");
      side = "left";
    }
    if (cfg.whatsappLink && !fabs.whatsapp) {
      var wa = document.createElement("a");
      wa.className = "belline-fab belline-second";
      wa.href = cfg.whatsappLink;
      wa.target = "_blank";
      wa.rel = "noopener";
      var label = cfg.whatsappLabel || whatsappLabel;
      wa.setAttribute("aria-label", label);
      wa.innerHTML = WA + "<span>" + escapeHtml(label) + "</span>";
      // Above the others: the quietest of the three, furthest from the bell.
      dock.insertBefore(wa, dock.firstChild);
      fabs.whatsapp = wa;
    }
  }

  /**
   * Ringing, when the venue switched it on.
   *
   * belline.ai's bell rings on a 1.5 s beat for as long as the page is open,
   * which is right on our own page and too much on somebody else's. So the
   * same ring, value for value, but in short bursts: two beats (3 s), first
   * a few seconds after the page settles, then every 20 seconds, and not more
   * than five times in a page view. Enough to be noticed from the corner of an
   * eye; not a thing that nags a visitor reading a price list.
   *
   * Never under prefers-reduced-motion — checked before every burst and
   * followed live, so switching the setting on stops a ring already running.
   * And it stops for good, for this page view, the moment the visitor shows
   * any interest in the widget: a pointer over it, focus on it, a touch, a
   * tap, the panel opening. Somebody who has noticed the button does not need
   * it waving at them, and a moving target is harder to hit.
   */
  var RING_FIRST_MS = 4000;
  var RING_EVERY_MS = 20000;
  var RING_FOR_MS = 3000;
  var RING_MAX = 5;
  var ringStarted = false;
  var ringStopped = false;
  var ringTimer = null;
  var ringEnd = null;
  var ringCount = 0;
  var stillQuery = null;
  try {
    stillQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  } catch (e) {
    stillQuery = null;
  }

  function reducedMotion() {
    // No way to ask counts as "reduce": motion is the thing that needs permission.
    return !stillQuery || stillQuery.matches;
  }

  function quiet() {
    clearTimeout(ringEnd);
    dock.classList.remove("belline-ringing");
  }

  function stopRinging() {
    ringStopped = true;
    clearTimeout(ringTimer);
    quiet();
  }

  function burst() {
    if (ringStopped) return;
    // Skipped, not spent, while the motion setting is on, the tab is in the
    // background or the panel is open.
    if (!reducedMotion() && !document.hidden && !panel) {
      dock.classList.add("belline-ringing");
      ringEnd = setTimeout(quiet, RING_FOR_MS);
      ringCount++;
    }
    if (ringCount < RING_MAX) ringTimer = setTimeout(burst, RING_EVERY_MS);
  }

  function ring() {
    if (ringStarted || ringStopped) return;
    ringStarted = true;
    ["pointerenter", "mouseenter", "focusin", "touchstart", "click"].forEach(function (type) {
      dock.addEventListener(type, stopRinging, { passive: true });
    });
    if (stillQuery) {
      var onChange = function () {
        if (stillQuery.matches) quiet();
      };
      if (stillQuery.addEventListener) stillQuery.addEventListener("change", onChange);
      else if (stillQuery.addListener) stillQuery.addListener(onChange);
    }
    ringTimer = setTimeout(burst, RING_FIRST_MS);
  }

  // Tell Belline the widget loaded here. This is how the dashboard knows it is
  // installed, the moment the page loads. The browser attaches this page's
  // origin; a site the venue did not name is refused, and the widget then
  // takes itself off the page rather than sit there refusing every tap.
  try {
    fetch(origin + "/api/embed/" + encodeURIComponent(key) + "/seen", { method: "POST", mode: "cors" })
      .then(function (r) {
        if (r.status === 403) {
          dock.remove();
          console.warn("[belline] this website is not on the venue's list, so the widget is not shown.");
        }
      })
      .catch(function () {
        /* a failed ping never costs the venue its widget */
      });
  } catch (e) {
    /* an old browser without fetch keeps the widget */
  }

  try {
    fetch(origin + "/api/embed/" + encodeURIComponent(key) + "/config", { mode: "cors" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(dress)
      .catch(function () {
        /* the defaults are already on screen */
      });
  } catch (e) {
    /* an old browser without fetch keeps the defaults */
  }

  function open(kind, label) {
    if (panel) return;
    stopRinging();

    panel = document.createElement("iframe");
    // The venue's own origin goes in the URL so the edge can name it in
    // frame-ancestors. It is not a credential — the page checks the *real*
    // framing origin against what the venue actually registered.
    panel.src =
      origin +
      "/embed/" +
      encodeURIComponent(key) +
      (kind === "chat" ? "/chat" : "") +
      "?o=" +
      encodeURIComponent(location.origin);
    panel.className = "belline-panel" + (side === "left" ? " belline-left" : "");
    // The call is ink and the chat is paper, and the frame behind each has to
    // match — otherwise the wrong colour flashes for as long as the iframe
    // takes to paint, which on a slow connection is not a flash.
    if (kind === "chat") panel.style.background = "#FFFFFF";
    panel.title = label;
    // The call needs the microphone from the first second and speakers to
    // answer. The chat needs the microphone too, but only for a voice note,
    // and only when the visitor holds the button — the browser asks then, not
    // on opening. Granting the frame permission to *ask* is not a prompt.
    panel.allow = kind === "voice" ? "microphone; autoplay" : "microphone";
    document.body.appendChild(panel);

    shut = document.createElement("button");
    shut.type = "button";
    shut.className = "belline-shut";
    shut.setAttribute("aria-label", kind === "chat" ? STRINGS.closeChat : STRINGS.closeCall);
    shut.textContent = "×";
    position(shut);
    shut.addEventListener("click", close);
    document.body.appendChild(shut);
    // Into the panel, so a keyboard is not left on the page behind it.
    try {
      shut.focus();
    } catch (e) {
      /* focus is a nicety, never a failure */
    }

    dock.style.display = "none";
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", reposition);
  }

  function position(el) {
    var narrow = window.innerWidth <= 520;
    el.style.top = narrow ? "14px" : "auto";
    el.style.bottom = narrow ? "auto" : "556px";
    el.style[side] = narrow ? "14px" : "32px";
  }

  function reposition() {
    if (shut) position(shut);
  }

  function close() {
    if (panel) panel.remove();
    if (shut) shut.remove();
    panel = null;
    shut = null;
    dock.style.display = "";
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", reposition);
    // Back to the button they pressed, rather than the top of their page.
    try {
      if (reopen) reopen.focus();
    } catch (e) {
      /* focus is a nicety, never a failure */
    }
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // The widget may be dropped into <head> by a tag manager, before <body>.
  if (document.body) {
    document.body.appendChild(dock);
  } else {
    document.addEventListener("DOMContentLoaded", function () {
      document.body.appendChild(dock);
    });
  }
})();
