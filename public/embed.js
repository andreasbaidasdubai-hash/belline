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

  var mode = (script.getAttribute("data-mode") || "voice").toLowerCase();
  if (mode !== "chat" && mode !== "both") mode = "voice";

  var voiceLabel = script.getAttribute("data-label") || "Talk to us";
  var chatLabel = script.getAttribute("data-chat-label") || "Chat with us";

  // One widget per page, whatever a page builder does with duplicate blocks.
  if (window.__bellineEmbed) return;
  window.__bellineEmbed = true;

  var css =
    ".belline-dock{position:fixed;bottom:24px;" + side + ":24px;z-index:2147483000;" +
    "display:flex;flex-direction:column;align-items:" + (side === "left" ? "flex-start" : "flex-end") +
    ";gap:10px}" +
    ".belline-fab{display:inline-flex;align-items:center;gap:10px;" +
    "padding:14px 22px 14px 18px;border:0;border-radius:999px;background:#14110D;color:#FBF9F5;" +
    "cursor:pointer;font:500 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
    "box-shadow:0 14px 34px -14px rgba(0,0,0,.5);transition:transform .16s ease}" +
    ".belline-fab:hover{transform:translateY(-2px)}" +
    ".belline-fab svg{width:24px;height:24px;color:#E8DCC6;display:block;flex:none}" +
    // The second button is the quieter one: paper rather than ink, so the pair
    // reads as one offer with a primary in it, not as two competing calls.
    ".belline-fab.belline-second{background:#F4F0E8;color:#14110D;" +
    "box-shadow:0 10px 26px -14px rgba(0,0,0,.42)}" +
    ".belline-fab.belline-second svg{color:#8A672E}" +
    ".belline-panel{position:fixed;bottom:24px;" + side + ":24px;z-index:2147483001;" +
    "width:380px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 48px);" +
    "border:0;border-radius:16px;overflow:hidden;background:#14110D;" +
    "box-shadow:0 24px 60px -20px rgba(0,0,0,.55)}" +
    ".belline-shut{position:fixed;z-index:2147483002;width:32px;height:32px;border:0;" +
    "border-radius:999px;background:rgba(251,249,245,.14);color:#FBF9F5;cursor:pointer;" +
    "font:16px/1 sans-serif;display:grid;place-items:center}" +
    "@media (max-width:520px){.belline-panel{inset:0;width:100%;height:100%;" +
    "max-width:none;max-height:none;border-radius:0}" +
    ".belline-dock{bottom:18px;" + side + ":18px}" +
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

  var dock = document.createElement("div");
  dock.className = "belline-dock";

  var panel = null;
  var shut = null;
  var reopen = null;

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
    return fab;
  }

  // Chat first in the column, so on `both` it sits above the bell. The bell
  // stays the filled button: it is the thing this product does that a chat
  // widget does not.
  if (mode === "chat") {
    dock.appendChild(fabFor("chat", chatLabel, BUBBLE, false));
  } else if (mode === "both") {
    dock.appendChild(fabFor("chat", chatLabel, BUBBLE, true));
    dock.appendChild(fabFor("voice", voiceLabel, BELL, false));
  } else {
    dock.appendChild(fabFor("voice", voiceLabel, BELL, false));
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
    panel.className = "belline-panel";
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
