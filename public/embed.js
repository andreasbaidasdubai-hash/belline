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
 * A third, video (a face to talk to), appears only when the venue's config
 * says `video: true` — Belline turns it on per venue; nothing on the tag can.
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
  var STRINGS = { closeChat: "Close chat", closeCall: "Close call", closeVideo: "Close video call" };
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
    // the accent, so the set reads as one offer with a primary in it. The
    // message button may be given a colour of its own (EmbedAppearance
    // `chatAccent`), which arrives as these variables on that button alone;
    // the paper here is what everybody who never picked one keeps.
    ".belline-fab.belline-second{background:var(--belline-second,#FFFFFF);color:var(--belline-second-text,#1D1D1F);" +
    "border:1px solid var(--belline-second-line,#D2D2D7);" +
    "box-shadow:0 10px 26px -14px rgba(0,0,0,.42)}" +
    ".belline-fab.belline-second svg{color:var(--belline-second-mark,#0071E3)}" +
    // Round: the mark alone, as on a phone, at every width.
    ".belline-dock.belline-round .belline-fab{padding:0;width:58px;height:58px;justify-content:center}" +
    ".belline-dock.belline-round .belline-fab span:not(.belline-logo){display:none}" +
    ".belline-panel{position:fixed;bottom:24px;right:24px;z-index:2147483001;" +
    "width:380px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 48px);" +
    "border:0;border-radius:14px;overflow:hidden;background:#1D1D1F;" +
    "box-shadow:0 24px 60px -20px rgba(0,0,0,.55)}" +
    ".belline-panel.belline-left{right:auto;left:24px}" +
    // Video needs room for a face: taller and a little wider than the call.
    ".belline-panel.belline-video{width:420px;height:640px}" +
    ".belline-shut{position:fixed;z-index:2147483002;width:32px;height:32px;border:0;" +
    "border-radius:999px;background:rgba(255,255,255,.14);color:#FFFFFF;cursor:pointer;" +
    "font:16px/1 sans-serif;display:grid;place-items:center}" +
    // The chat's sheet, its veil and its handle exist only on a phone; the
    // nodes are always built, and a wide screen simply has nothing to show.
    ".belline-veil,.belline-grab{display:none}" +
    "@media (max-width:520px){.belline-panel,.belline-panel.belline-left,.belline-panel.belline-video{inset:0;width:100%;height:100%;" +
    "max-width:none;max-height:none;border-radius:0}" +
    ".belline-dock{bottom:18px;right:18px}.belline-dock.belline-left{left:18px}" +
    ".belline-fab{padding:0;width:58px;height:58px;justify-content:center}" +
    ".belline-fab span:not(.belline-logo){display:none}" +
    // The chat opens inside the page, not as a second window (founder,
    // 2026-09-18). It used to take the whole screen: the visitor's own page
    // vanished, and closing it left them wondering where they had been. Now a
    // sheet slides up over the page, the page stays behind it and where it
    // was, and the veil, the handle or × puts it away.
    ":root{--belline-sheet-h:min(86dvh,calc(100dvh - 56px))}" +
    // The frame stops 22px short of the sheet's top: that strip is the handle,
    // which is also the sheet's rounded edge. An iframe cannot be padded.
    ".belline-panel.belline-sheet,.belline-panel.belline-sheet.belline-left{inset:auto 0 0 0;width:100%;max-width:none;" +
    "height:calc(var(--belline-sheet-h) - 22px);max-height:none;border-radius:0;transform:translateY(100%);" +
    "animation:belline-sheet-up .26s cubic-bezier(.22,.8,.28,1) forwards}" +
    // On a sheet the × lies on the chat's own white paper, where a translucent
    // white circle is invisible. It carries its own paper there.
    ".belline-shut.belline-on-sheet{background:#FFFFFF;color:#1D1D1F;" +
    "border:1px solid #D2D2D7;box-shadow:0 6px 18px -10px rgba(0,0,0,.4)}" +
    ".belline-veil{display:block;position:fixed;inset:0;z-index:2147483000;background:rgba(17,17,17,.38);" +
    "opacity:0;animation:belline-veil-in .22s ease forwards;-webkit-tap-highlight-color:transparent}" +
    ".belline-grab{display:grid;place-items:center;position:fixed;z-index:2147483002;left:0;right:0;" +
    "bottom:calc(var(--belline-sheet-h) - 22px);height:22px;padding:0;margin:0;border:0;" +
    "border-radius:18px 18px 0 0;background:#FFFFFF;cursor:pointer;touch-action:none}" +
    ".belline-grab::before{content:'';width:40px;height:4px;border-radius:999px;background:#D2D2D7}}" +
    "@keyframes belline-sheet-up{to{transform:translateY(0)}}@keyframes belline-veil-in{to{opacity:1}}" +
    "@media (prefers-reduced-motion:reduce){.belline-panel.belline-sheet,.belline-veil{animation-duration:.01ms}}" +
    // The venue's logo in place of the mark: always in a white circle, with
    // room around it, so a dark logo on a dark accent (or a white one on
    // white) still reads. Contained, never cropped — a wordmark stays whole.
    //
    // The circle is the logo plus a hair, not a saucer under it (founder, f6).
    // The white used to be a third wider than the picture in it, which on a
    // coloured button read as a sticker stuck on rather than the venue's mark.
    // 1px of padding on the pill and 2px round is enough to keep a white logo
    // off a white background, and no more.
    ".belline-logo{display:block;flex:none;width:28px;height:28px;box-sizing:border-box;padding:1px;" +
    "border-radius:999px;background:#FFFFFF;box-shadow:0 0 0 1px rgba(29,29,31,.1);overflow:hidden}" +
    ".belline-logo img{display:block;width:100%;height:100%;object-fit:contain;border-radius:999px}" +
    ".belline-fab.belline-has-logo{padding-top:12px;padding-bottom:12px;padding-left:14px}" +
    ".belline-dock.belline-round .belline-logo{width:40px;height:40px;padding:2px}" +
    "@media (max-width:520px){.belline-fab.belline-has-logo{padding:0}" +
    ".belline-fab .belline-logo{width:40px;height:40px;padding:2px}}" +
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
    "background:rgba(255,255,255,.92);padding:3px 9px;border-radius:999px;unicode-bidi:plaintext}" +
    // Video on: Belle's round bubble takes the dock at the call's own size, and the
    // chat and WhatsApp buttons become the round icons under her face. Voice has
    // no button of its own there: on the web, voice is the face. The notice line stays under it.
    ".belline-dock .belline-fab[hidden]{display:none}" +
    ".belline-dock.belline-has-video .belline-fab{display:none}";

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

  // A camera, drawn in the same hand: the video receptionist.
  var CAMERA =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<rect x="3" y="6.5" width="12.5" height="11" rx="2.5" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M15.5 10.6 20.4 8v8l-4.9-2.6Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

  var dock = document.createElement("div");
  dock.className = "belline-dock" + (side === "left" ? " belline-left" : "");

  var panel = null;
  var shut = null;
  /** The chat's sheet on a phone: what is under it, and the handle on its edge. */
  var veil = null;
  var grab = null;
  var reopen = null;
  var panelKind = null;
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
      if (cfg.strings.closeVideo) STRINGS.closeVideo = String(cfg.strings.closeVideo);
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
    // The message button's own colour, where the venue gave it one, and only
    // where it is the second button — on its own it is the main one and wears
    // the accent already. Not the WhatsApp button: that one is WhatsApp's. The
    // stylesheet keeps the quiet paper button as the fallback, so a venue that
    // never picked a colour is unchanged. The border follows the fill, or the
    // hairline would sit round a coloured pill as a ring.
    if (cfg.chatAccent && cfg.chatAccentText && fabs.chat && fabs.chat.className.indexOf("belline-second") >= 0) {
      fabs.chat.style.setProperty("--belline-second", cfg.chatAccent);
      fabs.chat.style.setProperty("--belline-second-text", cfg.chatAccentText);
      fabs.chat.style.setProperty("--belline-second-line", cfg.chatAccent);
      fabs.chat.style.setProperty("--belline-second-mark", cfg.chatAccentMark || cfg.chatAccentText);
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
    // Video, only where Belline has switched it on for this venue: a round
    // greeting bubble in the dock (embed-video.js, loaded now, after the page
    // has painted), with the chat and WhatsApp as round icons under it. The
    // Video button is only the fallback if that script cannot load. No session
    // exists until they tap. After WhatsApp, so both icons are there.
    if (cfg.video === true && !fabs.video) {
      var video = fabFor("video", script.getAttribute("data-video-label") || "Video call", CAMERA, true);
      dock.insertBefore(video, fabs.chat || fabs.voice || null);
      mountVideo(cfg.videoBubble || {}, video, cfg.ring === true);
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

  var videoCtl = null;

  /**
   * The video bubble, where Belline has switched video on for this venue.
   *
   * The bubble is the widget's front door, at the call's own size from the
   * first load: the face, "Talk to Belle", and a round icon for the chat and
   * for WhatsApp where the venue offers them, each doing exactly what its own
   * button did, ringing only where the venue chose ringing. The bell has no
   * icon: on the web, voice is the face. The call happens in the bubble itself
   * (embed-video.js). Without video none of this runs and the widget is the
   * one it always was.
   *
   * If embed-video.js cannot load, the buttons stay as they are and the Video
   * button opens the call panel directly instead.
   */
  function mountVideo(bubbleCfg, videoFab, ringing) {
    videoFab.hidden = true;

    function actions() {
      var list = [];
      if (fabs.chat) list.push({ kind: "chat", label: fabs.chat.getAttribute("aria-label") || chatLabel, run: function () { fabs.chat.click(); } });
      if (fabs.whatsapp) list.push({ kind: "whatsapp", label: fabs.whatsapp.getAttribute("aria-label") || whatsappLabel, run: function () { fabs.whatsapp.click(); } });
      return list;
    }

    function ready(api) {
      videoCtl = api.mount({
        env: window,
        config: bubbleCfg,
        origin: origin,
        key: key,
        hostOrigin: location.origin,
        side: side,
        strings: { closeCall: STRINGS.closeVideo },
        actions: actions,
        ring: ringing,
        place: function (bubble) {
          dock.insertBefore(bubble, dock.firstChild);
          dock.classList.add("belline-has-video");
        },
        onCallOpened: function () {
          stopRinging();
        },
        // "Type instead" during a call: the chat panel, as its own button opens it.
        onSwitch: function (to) {
          if (to === "chat") {
            reopen = null;
            open("chat", chatLabel);
          } else if (fabs.voice) {
            fabs.voice.click();
          }
        },
      });
    }

    if (window.BellineVideo) return ready(window.BellineVideo);
    (window.__bellineVideoReady = window.__bellineVideoReady || []).push(ready);
    var loader = document.createElement("script");
    loader.src = origin + "/embed-video.js";
    loader.async = true;
    loader.onerror = function () {
      // No bubble; the Video button opens the call directly instead.
      videoFab.hidden = false;
    };
    document.head.appendChild(loader);
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
      (kind === "video" ? "/video" : (kind === "chat" ? "/chat" : "")) +
      "?o=" +
      encodeURIComponent(location.origin);
    panel.className =
      "belline-panel" +
      (side === "left" ? " belline-left" : "") +
      (kind === "video" ? " belline-video" : "") +
      // Only the chat is a sheet. A call is a bar and a video call is a face:
      // neither is a page the visitor reads beside their own.
      (kind === "chat" ? " belline-sheet" : "");
    panelKind = kind;
    // The call is ink and the chat is paper, and the frame behind each has to
    // match — otherwise the wrong colour flashes for as long as the iframe
    // takes to paint, which on a slow connection is not a flash.
    if (kind === "chat" || kind === "video") panel.style.background = "#FFFFFF";
    panel.title = label;
    // The call needs the microphone from the first second and speakers to
    // answer. The chat needs the microphone too, but only for a voice note,
    // and only when the visitor holds the button — the browser asks then, not
    // on opening. Granting the frame permission to *ask* is not a prompt.
    panel.allow = kind === "voice" ? "microphone; autoplay" : "microphone";
    // Video, like the call, needs the microphone and the speakers from Start —
    // and never the camera: nothing on the other end looks at the visitor.
    if (kind === "video") panel.allow = "microphone; autoplay";
    // Under the sheet, so the page shows through and a tap beside it closes.
    if (kind === "chat") {
      veil = document.createElement("div");
      veil.className = "belline-veil";
      veil.addEventListener("click", close);
      document.body.appendChild(veil);
    }
    document.body.appendChild(panel);
    if (kind === "chat") {
      // A handle, not a second close button: × beside it is the one in the
      // accessibility tree, and two controls called "Close chat" is one too many.
      grab = document.createElement("div");
      grab.className = "belline-grab";
      grab.setAttribute("aria-hidden", "true");
      grab.addEventListener("click", close);
      var from = null;
      grab.addEventListener("pointerdown", function (e) {
        from = e.clientY;
        try {
          grab.setPointerCapture(e.pointerId);
        } catch (err) {
          /* capture is a nicety */
        }
      });
      grab.addEventListener("pointermove", function (e) {
        if (from !== null && e.clientY - from > 44) {
          from = null;
          close();
        }
      });
      grab.addEventListener("pointerup", function () {
        from = null;
      });
      document.body.appendChild(grab);
    }

    shut = document.createElement("button");
    shut.type = "button";
    shut.className = "belline-shut";
    shut.setAttribute(
      "aria-label",
      kind === "chat" ? STRINGS.closeChat : kind === "video" ? STRINGS.closeVideo : STRINGS.closeCall,
    );
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
    // On a phone the chat is a sheet: its × belongs on the sheet's own top
    // edge, not at the top of the visitor's page, which the sheet does not cover.
    if (narrow && panelKind === "chat") {
      el.style.top = "auto";
      el.style.bottom = "calc(var(--belline-sheet-h) - 64px)";
      el.style[side] = "14px";
      el.className = "belline-shut belline-on-sheet";
      return;
    }
    el.className = "belline-shut";
    el.style.top = narrow ? "14px" : "auto";
    el.style.bottom = narrow ? "auto" : panelKind === "video" ? "676px" : "556px";
    el.style[side] = narrow ? "14px" : "32px";
  }

  function reposition() {
    if (shut) position(shut);
  }

  function close() {
    if (panel) panel.remove();
    if (shut) shut.remove();
    if (veil) veil.remove();
    if (grab) grab.remove();
    panel = null;
    shut = null;
    veil = null;
    grab = null;
    panelKind = null;
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
