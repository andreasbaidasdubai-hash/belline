# Belline brand guidelines

"The Bell Button" in **Navy + Electric Blue**. Shape approved September 2026 as Direction C; palette and type moved to an enterprise look (after concordium.com) on 15 September 2026.

The front-desk bell becomes a button you press: one solid blue badge with a white bell that is the logo, the app icon, the avatar and the shape of every primary action. White grounds, navy type, calm grey body text and a single electric blue give Belline the steady look of business software an owner can trust with their phone line. Pages breathe in full-width bands: white, a light grey band, and one dark navy band.

**Personality.** The calm, competent front-of-house professional who is always there and never oversteps. Belline is for the owner of any UAE business that takes calls, messages or bookings and wants their phone and website chat answered properly, with their team told what to do next.

**Fixed:** a bell mark inside a round badge, the name Belline in Plus Jakarta Sans, a light interface, English copy, and no gradients, glows, orbs or sound waves in the brand marks.

Source of truth for every value below: `public/brand/tokens.css`. The marketing site (`public/site.css`, inlined at build) and the dashboard (`src/app/globals.css`) both read it.

---

## 1. Logo

### The parts

| Asset | File | Use |
|---|---|---|
| Primary lockup | `public/brand/belline-lockup.svg` | Headers, documents, anywhere the name is introduced. Blue badge, navy name |
| Stacked lockup | `public/brand/belline-lockup-stacked.svg` | Square or narrow spaces, sign-in screens |
| Lockup on blue | `public/brand/belline-lockup-on-brass.svg` | On a blue ground only: white badge, blue bell, white name. The file name is kept from Direction C so links do not break |
| Bell button (mark) | `public/brand/belline-mark.svg` | App icon, avatar, favicon source. White bell on blue |
| Bell button, inverse | `public/brand/belline-mark-inverse.svg` | Inside blue buttons and on blue grounds. Blue bell on white |
| Bare bell | `public/brand/belline-bell.svg`, `public/mark.svg` | Inline icon beside text, in `currentColor`; never as the logo |
| Bare bell, fixed colour | `public/logo.svg` (navy), `public/logo-dark.svg` (white) | Emails and places that cannot set `currentColor` |
| Wordmark | `public/brand/belline-wordmark.svg` (navy), `-ivory.svg` (white) | Only where the bell button already appears nearby |
| Mono, navy | `public/brand/belline-lockup-mono-ink.svg`, `belline-mark-mono-ink.svg` | One-colour printing, fax, embossing, stamps |
| Mono, white | `public/brand/belline-lockup-mono-ivory.svg`, `belline-mark-mono-ivory.svg` | Photography and the navy band (file names kept; the colour is white) |
| Favicon drawing | `public/brand/belline-favicon.svg`, `public/icon.svg` | 16 and 32 px, and the SVG favicon |

Raster files: `public/brand/png/belline-mark-{16,32,48,180,512,1024}.png`, `public/favicon.ico` (16/32/48), `public/apple-touch-icon.png` (180), `public/brand/png/belline-whatsapp-avatar-640.png`, `public/brand/png/belline-social-avatar-1080.png`, `public/brand/belline-og.png` (1200 × 630).

The wordmark SVGs embed a subset of Plus Jakarta Sans 700 holding only the letters of "Belline", so they render the same where the font is not installed.

### Construction

- Badge: a circle of diameter **D**, Blue `#2667FF`.
- Bell, white `#FFFFFF`, drawn in a 48-unit box and seated at 60% of the badge: knob radius 4.2, dome radius 15.5, base 38 × 7 with fully round ends.
- Name: Plus Jakarta Sans 700, tracking −0.025em, navy `#1B2735` (white on navy or blue).
- In the favicon drawing (16 px) the knob is squared to 2 px, with 1 px gaps and a 2 px base, so it stays crisp on a pixel grid.

### Clear space and proportions

- **x = badge radius ÷ 2** (D ÷ 4).
- Keep **1x** clear on every side of any lockup.
- Gap from badge to name = **1x**. Name font size **0.66 × D**.
- Stacked lockup: badge 52, gap 8, name 26 (scale together).

### Minimum sizes

| Form | Minimum |
|---|---|
| Horizontal lockup | 20 px badge |
| Stacked lockup | 24 px badge |
| Bell button alone | 16 px (use the favicon drawing below 32 px) |
| Bare bell | 12 px |
| Wordmark | 14 px type, about 48 px wide |

### Do not

- Recolour the badge or the bell outside the pairs above. Words and bells on blue are white; never navy on blue (3.22:1).
- Add gradients, shadows, glows, outlines, sound waves or motion lines.
- Put the bell outside its badge in a lockup, or rotate, stretch or re-space it.
- Set "Belline" in another typeface or weight, or track it tighter than −0.025em.
- Place the primary lockup on photography without a solid ground; use the mono white version on dark, even images.

### Avatars

- **WhatsApp profile (640 × 640) and social avatar (1080 × 1080):** full-bleed blue square, white bell inside the central 50%, so a circular crop never touches the knob or the base (checked at 160 and 40 px).
- WhatsApp is **coming soon**. Any mock-up, preview or caption that shows the WhatsApp avatar must say so. Never caption it as a live business account.
- **App icon and apple-touch-icon:** the same full-bleed square; the platform rounds the corners.
- **OG image:** white ground, navy headline in Plus Jakarta Sans 500, a small blue dot grid, the primary lockup. It names phone and website chat only.

---

## 2. Colour

Contrast is WCAG 2.x, computed from the hex values. AA means 4.5:1 for body text, 3:1 for large text (24 px+, or 19 px bold+) and for UI parts such as focus rings and input borders.

### Palette

| Token | Hex | Role |
|---|---|---|
| `--bl-ground` | `#FFFFFF` | Page ground, cards, inputs |
| `--bl-surface` | `#F2F4F7` | The light grey band, table heads, soft panels, the chat's business bubble |
| `--bl-sunken` | `#E9ECF2` | Hover and pressed rows |
| `--bl-blue-line` / `--bl-border` | `#DDE3F5` | The light blue card border and hairlines; never text |
| `--bl-rule` / `-soft` / `-strong` | navy at 12% / 7% / 18% | Dividers / inner dividers / outlined badges and inputs |
| `--bl-ink-900` | `#1B2735` | Navy ink: headings, primary text, mono marks |
| `--bl-text-2` | `#535862` | Body and secondary text |
| `--bl-muted` | `#5B6472` | Meta text, Coming soon |
| `--bl-blue` | `#2667FF` | Accent: primary buttons, the badge, focus ring, links on white |
| `--bl-blue-hover` | `#1A4FD6` | Primary hover; the accent as small text on any light ground other than white (`--bl-accent-text`) |
| `--bl-blue-pressed` | `#1640B0` | Primary pressed |
| `--bl-blue-tint` | `#EEF3FF` | Selected rows, current nav item, Beta badge, soft washes |
| `--bl-blue-lit` | `#8FB0FF` | Blue on navy surfaces |
| `--bl-navy` / `--bl-navy-card` | `#1B2735` / `#253041` | The dark band and the cards on it |
| `--bl-on-navy` / `--bl-on-navy-2` | `#FFFFFF` / `#C3CAD6` | Text on the navy band |
| `--bl-success` / `-tint` | `#047857` / `#ECFDF5` | Available, confirmed |
| `--bl-warning` / `-tint` | `#B45309` / `#FFFBEB` | Deposits due, handovers waiting |
| `--bl-danger` / `-tint` | `#B91C1C` / `#FEF2F2` | Errors, destructive actions |

**Muted was adjusted.** The first pick, `#667085`, passes on white (4.97) but only just on the grey band (4.51) and fails on the hover surface. `#5B6472` is a step darker and passes everywhere it sits: 5.98 on white, 5.43 on the grey band, 5.05 on sunken, 5.38 on the blue tint.

**Blue as small text.** `#2667FF` is 4.70:1 on white and is used as link text there only. On the grey band it is 4.27 and on the blue tint 4.23, so small blue text on those grounds uses `#1A4FD6` (6.08 / 6.03).

The earlier names (`--bl-indigo*`, `--bl-ivory`, `--bl-sand`, `--bl-brass`, `--bl-brass-desk`, `--bl-brass-tint`, `--bl-brass-lit`, `--bl-lagoon`, `--bl-alert`, `--bl-stone`, `--bl-graphite`, `--bl-rule-brass`) remain in `tokens.css` as aliases of the values above, so older CSS keeps working. New code uses the new names.

### Text pairings (all pass AA)

| Text | On | Ratio | Passes for |
|---|---|---|---|
| Navy `#1B2735` | White `#FFFFFF` | 15.13 | All text |
| Navy | Grey band `#F2F4F7` | 13.73 | All text |
| Navy | Sunken `#E9ECF2` | 12.78 | All text |
| Navy | Blue tint `#EEF3FF` | 13.61 | All text |
| Text 2 `#535862` | White | 7.14 | All text |
| Text 2 | Grey band | 6.48 | All text |
| Text 2 | Sunken | 6.04 | All text |
| Text 2 | Blue tint | 6.43 | All text |
| Muted `#5B6472` | White | 5.98 | All text |
| Muted | Grey band | 5.43 | All text |
| Muted | Sunken | 5.05 | All text |
| Muted | Blue tint | 5.38 | All text |
| White | Blue `#2667FF` | 4.70 | All text (primary buttons, visitor chat bubble) |
| White | Blue hover `#1A4FD6` | 6.70 | All text |
| White | Blue pressed `#1640B0` | 8.77 | All text |
| Blue `#2667FF` | White | 4.70 | All text (links on white only) |
| Blue hover `#1A4FD6` | White | 6.70 | All text |
| Blue hover | Grey band | 6.08 | All text (links and labels on grey) |
| Blue hover | Sunken | 5.66 | All text |
| Blue hover | Blue tint | 6.03 | All text (Beta badge, current nav item) |
| White | Navy `#1B2735` | 15.13 | All text (the navy band) |
| White | Navy card `#253041` | 13.31 | All text |
| On navy 2 `#C3CAD6` | Navy / navy card | 9.18 / 8.07 | All text |
| Blue lit `#8FB0FF` | Navy / navy card | 7.08 / 6.23 | All text |
| Success `#047857` | White / grey band | 5.48 / 4.98 | All text |
| Success | Success tint `#ECFDF5` | 5.21 | All text (Available badge) |
| Warning `#B45309` | White / grey band | 5.02 / 4.56 | All text |
| Warning | Warning tint `#FFFBEB` | 4.84 | All text |
| Danger `#B91C1C` | White / grey band | 6.47 / 5.87 | All text |
| Danger | Danger tint `#FEF2F2` | 5.91 | All text |
| White | Danger | 6.47 | All text (counts, destructive fills) |

### Non-text pairings

| Part | On | Ratio | Note |
|---|---|---|---|
| Blue badge | White / grey band | 4.70 / 4.27 | Passes 3:1 |
| White bell | Blue badge | 4.70 | Passes 3:1 |
| Blue focus ring | White / grey band / sunken / tint | 4.70 / 4.27 / 3.97 / 4.23 | Passes 3:1 |
| Blue focus ring | Navy / navy card | 3.22 / 2.83 | Not used: on the navy band focus rings are white (15.13 / 13.31) |
| Blue card line `#DDE3F5` | White | 1.28 | Decorative only; never the only sign of state |

### Rules

- **Words on blue are white.** Navy on blue is 3.22:1 and is never used.
- **Blue is the one accent.** Status colours (success, warning, danger) are separate and only mean status; blue never means "Available".
- One primary per view. Links are blue; everything else stays navy, text 2 or muted.
- No gradients in the marks or UI chrome. Soft blue washes between page sections are allowed on the website, kept faint and never behind body text. No shadows on cards; one soft lift (`--bl-elev-float`) only for things that float over content.

---

## 3. Typography

| Face | Weights | Role | Loading |
|---|---|---|---|
| **Plus Jakarta Sans** | 500 for large headlines, 600 for small headings, 700 for the wordmark | Display, headings, big numbers | Google Fonts, `wght@500;600;700`, `display=swap` |
| **Inter** | 400, 500, 600 | Body, UI, labels, buttons | Google Fonts, `wght@400;500;600;700` |

Large headlines are set in Plus Jakarta Sans at 500 with tight tracking, not bold: size carries the weight. Fallbacks: `ui-sans-serif, "Segoe UI", Arial, sans-serif` for display and `ui-sans-serif, -apple-system, "Segoe UI", Roboto, Arial, sans-serif` for text.

The embeddable widget button (`public/embed.js`) runs on customers' own websites and uses the system font on purpose; it loads no fonts.

### Scale

| Style | Web (px / line-height) | App (px / line-height) | Weight | Tracking |
|---|---|---|---|---|
| Display (H1) | 72 / 1.02 | 32 / 1.1 | 500 | −0.04em |
| H2 | 48 / 1.08 | 25 / 1.2 | 500 | −0.035em |
| H3 | 20 / 1.3 | 16 / 1.3 | 600 | −0.015em |
| Body | 17 / 1.6 | 15 / 1.5 | 400 | 0 |
| Small | 14 / 1.55 | 13 / 1.45 | 400 | 0 |
| Button | 15 / 1 | 13 / 1 | 600 | 0 |

Keep line length under about 70 characters for body text. No all-caps labels.

---

## 4. Iconography

- **Line icons** on a 24-unit grid, 2 px stroke, round caps and joins, no fills (phone, microphone, chat, close, send, plus). Blue inside cards on the website, navy in the dashboard, muted at 14 px for meta.
- **The bell is the only filled pictogram**, and it only appears as the brand mark or inside the bell button. Do not use it as a generic "notification" icon.
- No sound waves, robots, sparkles, orbs or circuit motifs.
- The website's blue dot grid is a decorative pattern behind the hero, never behind text, and hidden from screen readers.
- Third-party logos (Google, Microsoft, Fresha, SevenRooms, OpenTable, Meta) only for integrations that are live, and only as the owner's guidelines allow.

## 5. Photography

- **Real front-of-house moments**: reception counters, a salon chair between clients, a host stand before service, a clinic waiting area in daylight. Natural light.
- People are **customers and staff**, busy and at ease. Get written consent; record credits in `public/img/CREDITS.md`.
- Crop so there is calm negative space for a headline; do not put type over busy detail.
- No stock "AI" imagery, no glowing screens, no robots, no dark neon.
- When a photo carries the logo, use the mono white lockup on a dark, even area, or put the primary lockup on a solid white band.

---

## 6. UI foundations

| Token | Value |
|---|---|
| Radius, pills and buttons | 999 px |
| Radius, cards on the website | 16 px |
| Radius, dashboard panels | 14 px |
| Radius, inputs | 10 px |
| Spacing | 4 px base: 4, 8, 12, 16, 24, 32, 48, 64 |
| Card border | 1 px `#DDE3F5` |
| Hairline | 1 px at navy 12% |
| Elevation | None on cards. `--bl-elev-float` for menus and the chat dock only |
| Focus ring | Blue, 2 px, 2 px offset (`--bl-focus`). White on the navy band |

### Page rhythm (website)

- **White sections** hold thin blue-bordered white cards with a small blue line icon.
- **One light grey band** (`#F2F4F7`) holds white cards; on the homepage it carries the three set-up steps.
- **One dark navy band** (`#1B2735`) with `#253041` cards and white text; on the homepage it carries "It knows when to stop".
- A faint blue wash may run between sections. Headlines stay left-aligned; the FAQ is a centred accordion.

### Buttons

- **Primary:** blue pill, white words, Inter 600. Hover `#1A4FD6`, pressed `#1640B0`. One primary per view.
- **Secondary:** white pill with a 1 px `#DDE3F5` line and navy words. Hover fills the blue tint. On the navy band: transparent with a white line and white words.
- **Quiet:** blue link text (`#1A4FD6` off white), underline on hover.
- **Destructive:** danger text on white; hover fills the danger tint.
- Rows of buttons and badges **wrap** at narrow widths; they never shrink text or scroll sideways (checked at 375 px).
- Minimum touch target 44 px on touch screens.

### Status badges

Use these words and only these meanings. Never show a channel or integration as Available until it works end to end for that customer.

| Badge | Class | Look | Meaning |
|---|---|---|---|
| Available | `.state .state-available` | Success green on success tint, dot (5.21:1) | Live and switched on |
| Beta | `.state .state-beta` | Blue hover on blue tint (6.03:1) | Works, still being tested with real customers |
| Coming soon | `.state .state-soon` | Muted text, 18% navy outline (5.98:1 on white) | Not live. Today this includes WhatsApp |
| Request this integration | `.state .state-request` | Navy outline, navy words (15.13:1) | Invites the owner to ask for it |

### Inputs

White field, 1 px navy-18% line, 10 px radius, 15–16 px text. Focus: 2 px blue ring. Errors: danger text under the field saying what to fix.

### Website chat widget

- Header: white, the bell button at 36 px, business name in Inter 600, "Answered by Belline, AI receptionist"-style meta in muted.
- The business speaks on the grey `#F2F4F7` with navy words; the visitor speaks on blue with white words.
- Send is a round blue button with a white arrow. The microphone is white with an 18% outline.
- Focus ring blue. No shadows inside the panel.
- The floating buttons on customers' sites default to blue with white words and a white bell; the second button is white with a `#DDE3F5` line and a blue icon. A venue may choose another colour only if its words reach 4.5:1, and the bell then takes the words' colour.

### Dashboard

White ground, grey `#F2F4F7` panels for table heads and side areas, hairlines, page titles in Plus Jakarta Sans 600, the current page marked in blue-hover text on the blue tint, primary actions as blue pills. Numbers that are estimates are labelled **Estimate** and never styled like measured results. Sample data is labelled **Sample data**, and its numbers must agree with each other.

---

## 7. Voice and tone

Five attributes:

| Attribute | In practice |
|---|---|
| **Attentive** | Hears the caller out and answers the question asked. |
| **Precise** | Answers only from the business's own information and says when it doesn't know; gives numbers, not adjectives. |
| **Warm** | Sounds like a good receptionist, not a system. Plain words, full sentences. |
| **Discreet** | Hands clinical and sensitive questions to a person, and says it is doing so. |
| **Dependable** | Says what works today and nothing more. |

What Belline is not: an "AI from the future", a developer platform, cute or cartoon, loud or salesy, luxury-snob, dark or crypto, or a second calendar.

### Writing rules

- Sentence case everywhere, including buttons. Actions say what happens: "Get started", "Speak to Belline", "Call back".
- Name what the owner cares about (calls, enquiries, follow-ups), not how the system works.
- **Honesty is the brand.** Never say or imply that WhatsApp, a calendar or any integration is live before it is. Belline takes requests and passes them to the team; it does not book into a calendar or booking system. Use Available / Beta / Coming soon exactly as defined above.
- No statistics, testimonials, customer logos or live counters on the website.
- Estimates are called estimates. "About 3 hours of desk time, assuming 4 minutes a call" is right; "Saved 3 hours" is not.
- Errors say what happened and what to do next, without apology or blame.
- No exclamation marks in product copy. No "revolutionary", "seamless", "magic" or "never miss a call again".

### Examples

| Instead of | Write |
|---|---|
| "Never miss another customer!" | "Someone always answers." |
| "WhatsApp integration included" | "WhatsApp: coming soon" |
| "Seamlessly syncs with all your tools" | "Belline takes the request and your team books it where they always do." |
| "Oops! Something went wrong." | "Belline couldn't check this number just now. Nothing has changed. Try again in a minute." |
| "AI-powered booking engine" | "Belline answers, takes the details and tells your team what to do next." |

---

## 8. Working files

- Tokens: `public/brand/tokens.css`
- Logo system and rasters: `public/brand/`
- Name and logo conflict notes: `docs/brand/conflict-check.md`
- HTML version of this document: `docs/brand/guidelines.html`
