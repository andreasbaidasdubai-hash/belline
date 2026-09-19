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
 */

import { senderIdentityLine } from "../src/lib/sales/sending/unsubscribe";
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
      `<p class="fine">Belline is not yet a registered company, so there is no entity name or ` +
        `registration number to give you. That is the honest position and it is the same one ` +
        `stated in the footer of any email we sent you. The address above is read by a person.</p>`,
    );
  }
  return rows.join("");
}

/** The privacy paragraph, which differs by whether the notice is published. */
function privacyBlock(input: SenderPageInput): string {
  if (input.privacyUrl) {
    return `<p>If we wrote to you, <a href="${esc(input.privacyUrl)}">this notice</a> tells you what we ` +
      `hold about you, where we found it, why we believe we may use it, how long we keep it, and your ` +
      `right to object.</p>`;
  }
  return `<p>The full notice for people we contacted uninvited is published together with the company ` +
    `details above, and neither exists yet — so nothing is being cold-emailed from this domain in the ` +
    `meantime. Our general <a href="${esc(input.policyUrl)}">privacy policy</a> is up, and the address ` +
    `above answers the same questions from a person.</p>`;
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
<body>

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

    <p class="lead">Belline is an AI receptionist: it answers the phone, the chat and WhatsApp for
    businesses that lose bookings when nobody picks up. <strong>${esc(domain.domain)} is not the
    product.</strong> It is one of the domains Belline sends its own business email from, and that is
    all it is used for. The product, and everything worth reading, is at
    <a href="${esc(domain.site)}">belline.ai</a>.</p>

    <p class="legal-lang">If you received a message from this domain and are checking whether it is
    genuine: it is, and this page is here so that you can tell. Nobody else sends from
    ${esc(domain.domain)}.</p>

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
