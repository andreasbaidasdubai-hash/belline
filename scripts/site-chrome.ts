/**
 * The bits of the website every generated page is built from.
 *
 * The header lockup, the bell, the WhatsApp glyph, the floating buttons and
 * the demo call panel used to be `const`s inside scripts/build-site.ts, where
 * the four trade pages could reach them and nothing else could. The location
 * landing pages (scripts/seo/) need exactly the same chrome — that is the
 * point of them, that somebody arriving on
 * /ai-receptionist/restaurants/dubai and clicking through to the pricing does
 * not feel handed to another company — so the constants moved here rather
 * than being copied.
 *
 * There is one design system on this site and it is public/site.css. Nothing
 * in this file introduces a class that stylesheet does not already define.
 */

/** Escape text that lands in HTML. Every string is ours; a page that only escapes when it remembers to is a page that eventually forgets. */
export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The bare bell, for a button's face. */
export const MARK = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle cx="24" cy="9.5" r="3.5" fill="currentColor"/>
    <path d="M9 31.5a15 15 0 0 1 30 0Z" fill="currentColor"/>
    <rect x="5" y="35" width="38" height="5.5" rx="2.75" fill="currentColor"/>
  </svg>`;

/**
 * The bell button for the header and footer lockups: a white bell on a blue
 * (#0071E3) badge. Logo colours are fixed, so hex rather than currentColor.
 * The geometry is public/brand/belline-mark.svg.
 */
export const BADGE = `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="24" fill="#0071E3"/><g fill="#FFFFFF" transform="matrix(0.6 0 0 0.6 9.6 9.81)"><circle cx="24" cy="10" r="4.2"/><path d="M8.5 32a15.5 15.5 0 0 1 31 0Z"/><rect x="5" y="34.5" width="38" height="7" rx="3.5"/></g></svg>`;

/** Die Glocke im Sprechblasen-Umriss. Dasselbe Zeichen, getippt statt gesprochen. */
export const BUBBLE = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3 11.2C3 6.9 7.03 3.5 12 3.5s9 3.4 9 7.7c0 4.3-4.03 7.7-9 7.7a11 11 0 0 1-2.4-.26L5.4 20.5l.5-3.2A7.7 7.7 0 0 1 3 11.2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="12" cy="7.4" r="1.05" fill="currentColor"/>
    <path d="M8.7 13.1a3.3 3.3 0 0 1 6.6 0Z" fill="currentColor"/>
    <rect x="7.8" y="13.8" width="8.4" height="1.35" rx=".68" fill="currentColor"/>
  </svg>`;

/** WhatsApp, drawn in the same hand as the bell and the bubble. */
export const WA = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.9L3.6 20.4l4.1-1.1A8.5 8.5 0 1 0 12 3.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M9.2 8.6c.2-.4.4-.4.6-.4h.5c.2 0 .4 0 .5.4l.7 1.6c.1.2 0 .4-.1.5l-.5.6c-.1.1-.1.3 0 .4a6 6 0 0 0 2.6 2.5c.2.1.3.1.4 0l.6-.7c.1-.2.3-.2.5-.1l1.6.7c.2.1.4.2.4.4 0 .3 0 1-.4 1.4-.5.5-1.2.7-1.8.6a7.9 7.9 0 0 1-5.7-5.6c-.1-.6 0-1.3.6-1.8Z" fill="currentColor"/>
  </svg>`;

/**
 * The floating buttons: WhatsApp, the chat bubble, and the bell.
 *
 * The chat button is hidden in the markup and revealed by site.js — without
 * JavaScript there is nothing to open, and a dead button is worse than none.
 */
export const BELL_FAB = `<a class="wa-fab" href="https://app.belline.ai/whatsapp" aria-label="WhatsApp Belle">
  ${WA}
  <span class="wa-fab-say">WhatsApp Belle</span>
</a>

<button class="chat-fab" type="button" hidden
        data-chat="https://app.belline.ai/embed/be_belline_site/chat"
        aria-label="Write with Belle">
  ${BUBBLE}
  <span class="chat-fab-say">Write with Belle</span>
</button>

<a class="bell-fab" href="https://app.belline.ai/call?start=1" data-call aria-label="Speak to Belline now">
  ${MARK}
  <span class="bell-fab-say">Speak to Belline</span>
</a>`;

/**
 * The demo call panel: the same markup and the same site.js as the home
 * page's hero. The scenes differ per page; the machinery does not.
 */
export const CALL_PANEL = `      <div class="call rise rise-2" id="call" data-speaking="false">
        <div class="call-tabs" role="tablist" aria-label="Choose a call"></div>
        <div class="call-head">
          <span class="call-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
          <span class="call-status">Ringing</span>
          <span class="call-line"></span>
          <button class="call-listen" type="button" aria-pressed="false">
            <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
              <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z"/>
              <path d="M5 11a1 1 0 1 1 2 0 5 5 0 0 0 10 0 1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V21a1 1 0 1 1-2 0v-3.07A7 7 0 0 1 5 11Z"/>
            </svg>
            <span class="call-listen-label">Listen</span>
          </button>
          <audio class="call-audio" preload="none"></audio>
        </div>
        <div class="call-body" id="call-body" role="tabpanel" aria-live="polite"></div>
      </div>`;

/**
 * Belle's slot in the hero, exactly as public/landing.html carries it.
 *
 * A still placeholder and an ordinary link to the voice call, which is true
 * with JavaScript off and with `video.avatar` off. Where the venue's widget
 * config says video is on, site.js replaces the slot with Belle's real bubble
 * (embed-video.js). Nothing here claims video: the claim is in the flag copy
 * on the landing page, and a page that cannot make the claim shows the still.
 */
export const HERO_VIDEO = `      <figure class="hero-video" id="try-belle" data-hero-video>
        <div class="hv-slot" data-video-slot>
          <div class="hv-face" aria-hidden="true">
            <svg viewBox="0 0 48 48"><g class="hv-mark" transform="matrix(0.6 0 0 0.6 9.6 9.81)"><circle cx="24" cy="10" r="4.2"/><path d="M8.5 32a15.5 15.5 0 0 1 31 0Z"/><rect x="5" y="34.5" width="38" height="7" rx="3.5"/></g></svg>
          </div>
        </div>
        <figcaption class="hv-cap">
          <p class="hv-head"><span class="hv-title">Belle on your website</span> <span class="state state-available">Available</span></p>
          <p class="hv-text">Belle is Belline’s AI receptionist. Talk to her in your browser: it uses your microphone, never your camera.</p>
          <a class="btn line hv-cta" href="https://app.belline.ai/call?start=1" data-call>Talk to Belle</a>
          <p class="hv-early">Included in every plan.</p>
        </figcaption>
      </figure>`;

/** The phone-menu button that sits beside the nav on every page. */
export const MENU_TOGGLE = `    <button class="menu-toggle" type="button" aria-expanded="false"
            aria-controls="site-nav" aria-label="Open menu">
      <span class="bar"></span>
    </button>`;

/** The demo line we publish, and the sentence that tells a caller what it costs them. */
export const DEMO_NUMBER = "+15717785920";
export const DEMO_NUMBER_SPOKEN = "+1 571 778 5920";
