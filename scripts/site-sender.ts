/**
 * One small, true page per sending domain.
 *
 * We send cold business email from four lookalike domains — trybelline.com,
 * getbelline.com, bellineai.com, hellobelline.com (src/lib/sales/sending/
 * domains.ts owns the list). Two things follow from that and both end here.
 *
 * The first is deliverability arithmetic. A domain with SPF, DKIM, DMARC and
 * MX but no website at all is a shape spam filters know well, because it is
 * the shape of a domain registered last week to send one campaign from. A
 * small honest page is cheap and removes the signal.
 *
 * The second matters more. Somebody who gets an unexpected email at work and
 * wants to know whether it is real does not read headers — they type the
 * domain into a browser. Whatever is there is the answer to "is this a
 * person or a scam". So this page's job is to be that answer: what Belline
 * is, that this domain carries Belline's own mail and nothing else, who is
 * writing, and how to make it stop without going back to find the email. It
 * sells nothing. There is no signup button on it, on purpose — the visitor is
 * verifying us, not shopping, and a "Get started" here would read as the
 * pitch continuing after they came looking for the exit.
 *
 * It is the site's own stylesheet and the site's own lockup, because a
 * verification page in a second design system verifies nothing.
 *
 * `noindex, nofollow`: four near-identical pages naming Belline are four
 * competitors to belline.ai in a search for Belline, and none of them is the
 * page we want found.
 *
 * Two things sit above everything else, side by side, because of who reads
 * this page and why:
 *
 *  - the sentence that says the message was genuine. It used to be a third of
 *    the way down, under a paragraph of product description, which is past
 *    the fold on a phone — the one line the visitor came for, below the one
 *    thing they did not;
 *  - Belle's face, round, linking to belline.ai. The page was a wall of grey
 *    text with nobody in it and no route to the product, and a recipient who
 *    recognises the face from the email has their answer before reading a
 *    word. It is the greeting clip's poster frame (`GREETING_POSTER_PATH`),
 *    the same still the website's hero and the demo mail use, and it is a
 *    still: a live session here would spend Tavus minutes on strangers who
 *    came to check an email, not to be sold to. The circle carries the same
 *    blue ring as the hero's (`.hv-face` in site.css), and an underlined
 *    "Meet Belle at belline.ai" sits under it, because a picture does not
 *    look like a link.
 *
 * That face is the only route to the product here, and deliberately the only
 * one: no price, no "Get started", no feature list. Anyone curious can follow
 * her; anyone suspicious gets their answer and the exit.
 */

import { senderIdentityLine } from "../src/lib/sales/sending/unsubscribe";
import { GREETING_POSTER_PATH } from "../src/lib/video/config";
import type { SendingDomainInfo } from "../src/lib/sales/sending/domains";
import type { LegalIdentity } from "../src/lib/legal/identity";

/** The bell badge, byte-for-byte the one on every other page. */
const BADGE = `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="24" fill="#0071E3"/><g fill="#FFFFFF" transform="matrix(0.6 0 0 0.6 9.6 9.81)"><circle cx="24" cy="10" r="4.2"/><path d="M8.5 32a15.5 15.5 0 0 1 31 0Z"/><rect x="5" y="34.5" width="38" height="7" rx="3.5"/></g></svg>`;

function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export interface SenderPageInput {
  domain: SendingDomainInfo;
  /** The sender identity, exactly as the email footers carry it. */
  legal: LegalIdentity;
  /**
   * The outreach privacy notice's URL, or null when the build is not
   * publishing it because there is no controller to name yet. Never a guess:
   * a link to a page that 404s, on the one page whose whole job is to be
   * checkable, is worse than saying plainly that it is not up yet.
   */
  privacyUrl: string | null;
  /** Where the general privacy policy is. Always published. */
  policyUrl: string;
  /** The stop-page route, on this same domain (src/app/u/route.ts). */
  unsubscribePath: string;
}

/**
 * What the page says about who is writing.
 *
 * `senderIdentityLine` is the email footer's own function, so the line a
 * recipient reads here is the line they read in the message, character for
 * character. While the company does not exist that is "Belline" and an email
 * address, and the page says so in words rather than leaving a reader to
 * wonder whether the company name failed to load.
 */
function identityBlock(legal: LegalIdentity): string {
  const line = senderIdentityLine(legal);
  const rows = [`<p>${esc(line)}`];
  if (legal.managingDirector) rows.push(`<br>Represented by ${esc(legal.managingDirector)}`);
  if (legal.registration) rows.push(`<br>Registered under ${esc(legal.registration)}`);
  if (legal.vatNumber) rows.push(`<br>VAT ${esc(legal.vatNumber)}`);
  if (legal.email) rows.push(`<br><a href="mailto:${esc(legal.email)}">${esc(legal.email)}</a>`);
  rows.push("</p>");

  if (!legal.entity) {
    rows.push(
      `<p class="fine">Belline is not yet a registered company: no entity name, no registration ` +
        `number, as our email footers also say. A person reads the address above.</p>`,
    );
  }
  return rows.join("");
}

/**
 * Belle, round, at the top, linking to belline.ai.
 *
 * `GREETING_POSTER_PATH` and not a copy of the filename: the still is
 * content-addressed against the face it was generated from, and a page that
 * hard-coded today's name would show a broken image the day the face changes.
 * `scripts/build-site.ts` rewrites it to the hashed asset name on its way out,
 * the same rewrite every other page's imagery gets, and the file is served
 * from the site root — so it resolves on all four sending hostnames without
 * any of them needing an absolute URL to belline.ai.
 */
function belleBlock(site: string): string {
  return `<figure class="sender-belle">
      <a class="sender-face" href="${esc(site)}">
        <img src="${esc(GREETING_POSTER_PATH)}" width="152" height="152" decoding="async"
        alt="Belle, the receptionist who answers for Belline's customers">
      </a>
      <figcaption><strong>This is Belle.</strong> She answers the calls for Belline's customers, and
      she is the face in the email we sent you.
      <a class="sender-meet" href="${esc(site)}">Meet Belle at belline.ai</a></figcaption>
    </figure>`;
}

/** The privacy paragraph, which differs by whether the notice is published. */
function privacyBlock(input: SenderPageInput): string {
  if (input.privacyUrl) {
    return `<p>If we wrote to you, <a href="${esc(input.privacyUrl)}">this notice</a> tells you what we ` +
      `hold, where we found it, why we may use it, how long we keep it, and how to object.</p>`;
  }
  return `<p>The notice for people we contact uninvited goes up with those company details, and ` +
    `neither exists yet — so nothing is cold-emailed from here meanwhile. Our ` +
    `<a href="${esc(input.policyUrl)}">privacy policy</a> is up.</p>`;
}

/**
 * The page.
 *
 * Returned as a string rather than written, so `scripts/check-sender-pages.ts`
 * can build all four and read them without a build directory.
 */
export function senderPage(input: SenderPageInput): string {
  const { domain, legal } = input;
  const title = `${domain.domain} — Belline`;
  const description =
    `${domain.domain} is a domain Belline sends its own business email from. ` +
    `Who we are, and how to stop hearing from us.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#FFFFFF">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/site.css">
</head>
<body class="sender-doc">

<header class="top">
  <div class="wrap top-in">
    <a class="brand" href="${esc(domain.site)}">
      ${BADGE}
      <span>Belline</span>
    </a>
  </div>
</header>

<main>
  <article class="wrap legal">
    <p class="eyebrow">Sending domain</p>
    <h1 class="display">${esc(domain.domain)}</h1>

    <div class="sender-top">
      <div class="sender-say">
        <p class="sender-yes"><strong>This is genuine.</strong> An email from
        ${esc(domain.domain)} brought you here to check — that is the answer, and nobody else sends
        from this domain.</p>

        <p class="sender-what">Belline is an AI receptionist: the phone, the chat and WhatsApp
        answered for businesses that lose bookings when nobody picks up.
        <strong>${esc(domain.domain)} is not the product</strong> — just one of the domains
        Belline sends its own business email from.</p>
      </div>
      ${belleBlock(domain.site)}
    </div>

    <h2>Who is writing</h2>
    ${identityBlock(legal)}

    <h2>Your data</h2>
    ${privacyBlock(input)}

    <h2>How to stop, permanently</h2>
    <p>Two ways, both final, neither of which needs you to go and find an old email:</p>
    <ul>
      <li><a href="${esc(input.unsubscribePath)}">Unsubscribe</a> — the page explains the one-click
      link if you still have the message in front of you.</li>
      <li>Reply <strong>no thanks</strong> to anything we sent, or write those two words to
      <a href="mailto:${esc(legal.email)}?subject=no%20thanks">${esc(legal.email)}</a>.</li>
    </ul>
    <p>Either one suppresses your whole business — every address at it, not only the one we wrote to —
    and it is permanent. We do not ask for a reason and we do not ask you to prove who you are.</p>
  </article>
</main>

<footer>
  <div class="wrap foot-in">
    <a class="brand" href="${esc(domain.site)}">
      ${BADGE}
      <span>Belline</span>
    </a>
    <p>
      <a href="${esc(domain.site)}">belline.ai</a> ·
      <a href="mailto:${esc(legal.email)}">${esc(legal.email)}</a> ·
      <a href="${esc(input.unsubscribePath)}">Unsubscribe</a><br>
      ${input.privacyUrl ? `<a href="${esc(input.privacyUrl)}">How we got your details</a> · ` : ""}<a href="${esc(input.policyUrl)}">Privacy policy</a>
    </p>
  </div>
</footer>

</body>
</html>
`;
}
