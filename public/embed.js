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
  var attrSide = script.hasAttribute("data-side");
  var attrVoice = script.hasAttribute("data-label");
  var attrChat = script.hasAttribute("data-chat-label");

  // One widget per page, whatever a page builder does with duplicate blocks.
  if (window.__bellineEmbed) return;
  window.__bellineEmbed = true;

  var css =
    ".belline-dock{position:fixed;bottom:24px;right:24px;z-index:2147483000;" +
    "display:flex;flex-direction:column;align-items:flex-end;gap:10px;" +
    "--belline-accent:#14110D;--belline-accent-text:#FBF9F5;--belline-accent-mark:#E8DCC6}" +
    ".belline-dock.belline-left{right:auto;left:24px;align-items:flex-start}" +
    ".belline-fab{display:inline-flex;align-items:center;gap:10px;text-decoration:none;" +
    "padding:14px 22px 14px 18px;border:0;border-radius:999px;" +
    "background:var(--belline-accent);color:var(--belline-accent-text);" +
    "cursor:pointer;font:500 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
    "box-shadow:0 14px 34px -14px rgba(0,0,0,.5);transition:transform .16s ease}" +
    ".belline-fab:hover{transform:translateY(-2px)}" +
    ".belline-fab svg{width:24px;height:24px;color:var(--belline-accent-mark);display:block;flex:none}" +
    // The second and third buttons are the quieter ones: paper rather than
    // the accent, so the set reads as one offer with a primary in it.
    ".belline-fab.belline-second{background:#F4F0E8;color:#14110D;" +
    "box-shadow:0 10px 26px -14px rgba(0,0,0,.42)}" +
    ".belline-fab.belline-second svg{color:#8A672E}" +
    // Round: the mark alone, as on a phone, at every width.
    ".belline-dock.belline-round .belline-fab{padding:0;width:58px;height:58px;justify-content:center}" +
    ".belline-dock.belline-round .belline-fab span{display:none}" +
    ".belline-panel{position:fixed;bottom:24px;right:24px;z-index:2147483001;" +
    "width:380px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 48px);" +
    "border:0;border-radius:16px;overflow:hidden;background:#14110D;" +
    "box-shadow:0 24px 60px -20px rgba(0,0,0,.55)}" +
    ".belline-panel.belline-left{right:auto;left:24px}" +
    ".belline-shut{position:fixed;z-index:2147483002;width:32px;height:32px;border:0;" +
    "border-radius:999px;background:rgba(251,249,245,.14);color:#FBF9F5;cursor:pointer;" +
    "font:16px/1 sans-serif;display:grid;place-items:center}" +
    "@media (max-width:520px){.belline-panel,.belline-panel.belline-left{inset:0;width:100%;height:100%;" +
    "max-width:none;max-height:none;border-radius:0}" +
    ".belline-dock{bottom:18px;right:18px}.belline-dock.belline-left{left:18px}" +
    ".belline-fab{padding:0;width:58px;height:58px;justify-content:center}" +
    ".belline-fab span{display:none}}" +
    "@media (prefers-reduced-motion:reduce){.belline-fab{transition:none}}";

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
    fab.className = "belline-fab" + (second ? " belline-second" : "");
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
    var span = fab.querySelector("span");
    if (span) span.textContent = label;
  }

  function dress(cfg) {
    if (!cfg || typeof cfg !== "object") return;
    // No attribute on the tag means the dashboard decides what is offered —
    // so switching chat on in Belline reaches the site without a re-paste.
    if (!attrMode && (cfg.mode === "voice" || cfg.mode === "chat" || cfg.mode === "both") && cfg.mode !== mode) {
      mode = cfg.mode;
      buildMode(mode);
    }
    if (!attrVoice) relabel("voice", cfg.voiceLabel);
    if (!attrChat) relabel("chat", cfg.chatLabel);
    if (cfg.accent && cfg.accentText) {
      dock.style.setProperty("--belline-accent", cfg.accent);
      dock.style.setProperty("--belline-accent-text", cfg.accentText);
      dock.style.setProperty("--belline-accent-mark", cfg.accentMark || "#E8DCC6");
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
    if (kind === "chat") panel.style.background = "#FBF9F5";
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
    shut.setAttribute("aria-label", "Close");
    shut.textContent = "×";
    position(shut);
    shut.addEventListener("click", close);
    document.body.appendChild(shut);

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
