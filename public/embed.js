/**
 * Belline, on your own website.
 *
 *   <script src="https://app.belline.ai/embed.js" data-belline="be_xxx" async></script>
 *
 * One line, no build step, no package to install. The most common thing on the
 * other end of this is a Squarespace footer box, and anything that needs more
 * than a paste does not get installed.
 *
 * What it does: puts a bell in the corner. Tapping it opens a panel in which
 * the visitor is talking — actually talking, out loud — to that venue's
 * receptionist. Not a chat bubble, not a form, not a "how can I help you
 * today?" that is really a search box.
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
  var label = script.getAttribute("data-label") || "Talk to us";
  var side = script.getAttribute("data-side") === "left" ? "left" : "right";

  // One widget per page, whatever a page builder does with duplicate blocks.
  if (window.__bellineEmbed) return;
  window.__bellineEmbed = true;

  var css =
    ".belline-fab{position:fixed;bottom:24px;" + side + ":24px;z-index:2147483000;" +
    "display:inline-flex;align-items:center;gap:10px;padding:14px 22px 14px 18px;" +
    "border:0;border-radius:999px;background:#14110D;color:#FBF9F5;cursor:pointer;" +
    "font:500 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
    "box-shadow:0 14px 34px -14px rgba(0,0,0,.5);transition:transform .16s ease}" +
    ".belline-fab:hover{transform:translateY(-2px)}" +
    ".belline-fab svg{width:24px;height:24px;color:#E8DCC6;display:block}" +
    ".belline-panel{position:fixed;bottom:24px;" + side + ":24px;z-index:2147483001;" +
    "width:380px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 48px);" +
    "border:0;border-radius:16px;overflow:hidden;background:#14110D;" +
    "box-shadow:0 24px 60px -20px rgba(0,0,0,.55)}" +
    ".belline-shut{position:fixed;z-index:2147483002;width:32px;height:32px;border:0;" +
    "border-radius:999px;background:rgba(251,249,245,.14);color:#FBF9F5;cursor:pointer;" +
    "font:16px/1 sans-serif;display:grid;place-items:center}" +
    "@media (max-width:520px){.belline-panel{inset:0;width:100%;height:100%;" +
    "max-width:none;max-height:none;border-radius:0}" +
    ".belline-fab{bottom:18px;" + side + ":18px;padding:0;width:58px;height:58px;" +
    "justify-content:center}.belline-fab span{display:none}}" +
    "@media (prefers-reduced-motion:reduce){.belline-fab{transition:none}}";

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var BELL =
    '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">' +
    '<circle cx="24" cy="9.5" r="3.5" fill="currentColor"/>' +
    '<path d="M9 31.5a15 15 0 0 1 30 0Z" fill="currentColor"/>' +
    '<rect x="5" y="35" width="38" height="5.5" rx="2.75" fill="currentColor"/></svg>';

  var fab = document.createElement("button");
  fab.type = "button";
  fab.className = "belline-fab";
  fab.setAttribute("aria-label", label);
  fab.innerHTML = BELL + "<span>" + escapeHtml(label) + "</span>";

  var panel = null;
  var shut = null;

  function open() {
    if (panel) return;

    panel = document.createElement("iframe");
    // The venue's own origin goes in the URL so the edge can name it in
    // frame-ancestors. It is not a credential — the page checks the *real*
    // framing origin against what the venue actually registered.
    panel.src =
      origin + "/embed/" + encodeURIComponent(key) + "?o=" + encodeURIComponent(location.origin);
    panel.className = "belline-panel";
    panel.title = label;
    panel.allow = "microphone; autoplay";
    document.body.appendChild(panel);

    shut = document.createElement("button");
    shut.type = "button";
    shut.className = "belline-shut";
    shut.setAttribute("aria-label", "Close");
    shut.textContent = "×";
    position(shut);
    shut.addEventListener("click", close);
    document.body.appendChild(shut);

    fab.style.display = "none";
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
    fab.style.display = "";
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", reposition);
    // Back to the button they pressed, rather than the top of their page.
    try {
      fab.focus();
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

  fab.addEventListener("click", open);

  // The widget may be dropped into <head> by a tag manager, before <body>.
  if (document.body) {
    document.body.appendChild(fab);
  } else {
    document.addEventListener("DOMContentLoaded", function () {
      document.body.appendChild(fab);
    });
  }
})();
