# Belline brand guidelines

"The Bell Button" in the **Apple look**. Shape approved September 2026 as Direction C; palette and type moved to an enterprise look on 15 September 2026, and to a look measured on apple.com on 17 September 2026.

The front-desk bell becomes a button you press: one solid blue badge with a white bell that is the logo, the app icon, the avatar and the shape of every primary action. White and light grey grounds, near-black type, calm grey secondary text and a single Apple blue give Belline the quiet, precise look of software an owner can trust with their phone line. Pages breathe in full-width bands: white, a light grey band, and one near-black band.

**Personality.** The calm, competent front-of-house professional who is always there and never oversteps. Belline is for the owner of any UAE business that takes calls, messages or bookings and wants their phone and website chat answered properly, with their team told what to do next.

**Fixed:** a bell mark inside a round badge, the name Belline set in its wordmark, a light interface, English copy, and no gradients, glows, orbs or sound waves in the brand marks.

Source of truth for every value below: `public/brand/tokens.css`. The marketing site (`public/site.css`, inlined at build) and the dashboard (`src/app/globals.css`) both read it.

---

## 1. Logo

### The parts

| Asset | File | Use |
|---|---|---|
| Primary lockup | `public/brand/belline-lockup.svg` | Headers, documents, anywhere the name is introduced. Blue badge, ink name |
| Stacked lockup | `public/brand/belline-lockup-stacked.svg` | Square or narrow spaces, sign-in screens |
| Lockup on blue | `public/brand/belline-lockup-on-brass.svg` | On a blue ground only: white badge, blue bell, white name. The file name is kept from Direction C so links do not break |
| Bell button (mark) | `public/brand/belline-mark.svg` | App icon, avatar, favicon source. White bell on blue |
| Bell button, inverse | `public/brand/belline-mark-inverse.svg` | Inside blue buttons and on blue grounds. Blue bell on white |
| Bare bell | `public/brand/belline-bell.svg`, `public/mark.svg` | Inline icon beside text, in `currentColor`; never as the logo |
| Bare bell, fixed colour | `public/logo.svg` (ink), `public/logo-dark.svg` (white) | Emails and places that cannot set `currentColor` |
| Wordmark | `public/brand/belline-wordmark.svg` (ink), `-ivory.svg` (white) | Only where the bell button already appears nearby |
| Mono, ink | `public/brand/belline-lockup-mono-ink.svg`, `belline-mark-mono-ink.svg` | One-colour printing, fax, embossing, stamps |
| Mono, white | `public/brand/belline-lockup-mono-ivory.svg`, `belline-mark-mono-ivory.svg` | Photography and the dark band (file names kept; the colour is white) |
| Favicon drawing | `public/brand/belline-favicon.svg`, `public/icon.svg` | 16 and 32 px, and the SVG favicon |

Raster files: `public/brand/png/belline-mark-{16,32,48,180,512,1024}.png`, `public/favicon.ico` (16/32/48), `public/apple-touch-icon.png` (180), `public/brand/png/belline-whatsapp-avatar-640.png`, `public/brand/png/belline-social-avatar-1080.png`, `public/brand/belline-og.png` (1200 × 630).

The wordmark SVGs embed a subset font (the Plus Jakarta Sans 700 letters of "Belline", unchanged since 15 September) so the logo renders the same everywhere. It is part of the mark, not a webfont: no page loads Plus Jakarta Sans any more. The rasters are rendered from the SVGs with Playwright.

### Construction

- Badge: a circle of diameter **D**, Blue `#0071E3`.
- Bell, white `#FFFFFF`, drawn in a 48-unit box and seated at 60% of the badge: knob radius 4.2, dome radius 15.5, base 38 × 7 with fully round ends.
- Name: the wordmark letters at 700, tracking −0.025em, ink `#1D1D1F` (white on dark or blue). Where the name is live text (site header, app) it is set in the display stack at 700.
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

- Recolour the badge or the bell outside the pairs above. Words and bells on blue are white; never ink on blue (3.58:1).
- Add gradients, shadows, glows, outlines, sound waves or motion lines.
- Put the bell outside its badge in a lockup, or rotate, stretch or re-space it.
- Set "Belline" in another typeface or weight, or track it tighter than −0.025em.
- Place the primary lockup on photography without a solid ground; use the mono white version on dark, even images.

### Avatars

- **WhatsApp profile (640 × 640) and social avatar (1080 × 1080):** full-bleed blue square, white bell inside the central 50%, so a circular crop never touches the knob or the base (checked at 160 and 40 px).
- WhatsApp is **coming soon**. Any mock-up, preview or caption that shows the WhatsApp avatar must say so. Never caption it as a live business account.
- **App icon and apple-touch-icon:** the same full-bleed square; the platform rounds the corners.
- **OG image:** white ground fading to the blue tint, ink headline in the display stack at 600 (rendered in Inter), a small blue dot grid, the primary lockup. It names phone and website chat only.

---

## 2. Colour

Contrast is WCAG 2.x, computed from the hex values. AA means 4.5:1 for body text, 3:1 for large text (24 px+, or 19 px bold+) and for UI parts such as focus rings and input borders.

### Palette

| Token | Hex | Role |
|---|---|---|
| `--bl-ground` | `#FFFFFF` | Page ground, cards, inputs |
| `--bl-surface` | `#F5F5F7` | The light grey band, table heads, soft panels, the chat's business bubble, the dashboard's hover rows |
| `--bl-sunken` | `#E8E8ED` | Pressed and sunken fills; never under small grey text |
| `--bl-blue-line` / `--bl-border` | `#D2D2D7` | The neutral card border and hairlines; never text |
| `--bl-rule` / `-soft` / `-strong` | black at 12% / 7% / 18% | Dividers / inner dividers / outlined badges and inputs |
| `--bl-ink-900` | `#1D1D1F` | Ink: headings, primary text, mono marks |
| `--bl-text-2` | `#6E6E73` | Body and secondary text |
| `--bl-muted` | `#6E6E73` | Meta text, Coming soon |
| `--bl-blue` | `#0071E3` | Accent: primary buttons, the badge, focus ring |
| `--bl-blue-hover` | `#006EDB` | Primary hover |
| `--bl-blue-pressed` | `#0062C4` | Primary pressed |
| `--bl-accent-text` | `#0066CC` | Blue as small text and links on any light ground |
| `--bl-blue-tint` | `#F0F6FE` | Selected rows, current nav item, Beta badge, soft washes |
| `--bl-blue-lit` | `#2997FF` | Blue on dark surfaces |
| `--bl-navy` / `--bl-navy-card` | `#1D1D1F` / `#333336` | The dark band and the cards on it (names kept from the navy palette) |
| `--bl-on-navy` / `--bl-on-navy-2` | `#F5F5F7` / `#A1A1A6` | Text on the dark band |
| `--bl-success` / `-tint` | `#047857` / `#ECFDF5` | Available, confirmed |
| `--bl-warning` / `-tint` | `#B45309` / `#FFFBEB` | Deposits due, handovers waiting |
| `--bl-danger` / `-tint` | `#B91C1C` / `#FEF2F2` | Errors, destructive actions |

**Greys.** Apple's secondary grey `#6E6E73` is 5.07 on white, 4.66 on the grey band and 4.67 on the blue tint, so it serves as both secondary and meta text. Apple's lighter `#86868B` is only 3.62 on white and 3.33 on the grey band: large or decorative text only. On sunken `#E8E8ED` the grey is 4.15, so the dashboard's hover rows use the grey band instead.

**Blue.** White on `#0071E3` is 4.70, fine for button words at any size. Apple's own hover `#0077ED` is lighter and leaves white at 4.32, under AA for 17 px text, so hover goes a step darker (`#006EDB`, 4.94). As small text, blue is `#0066CC` (5.57 on white); `#0071E3` is 4.31 on the grey band and 4.32 on the tint.

The earlier names (`--bl-indigo*`, `--bl-ivory`, `--bl-sand`, `--bl-brass`, `--bl-brass-desk`, `--bl-brass-tint`, `--bl-brass-lit`, `--bl-lagoon`, `--bl-alert`, `--bl-stone`, `--bl-graphite`, `--bl-rule-brass`) remain in `tokens.css` as aliases, and `--bl-navy*` keep their names with the new values, so older CSS keeps working. New code uses the new names.

### Text pairings

| Text | On | Ratio | Passes for |
|---|---|---|---|
| Ink `#1D1D1F` | White `#FFFFFF` | 16.83 | All text |
| Ink | Grey band `#F5F5F7` | 15.46 | All text |
| Ink | Sunken `#E8E8ED` | 13.78 | All text |
| Ink | Blue tint `#F0F6FE` | 15.48 | All text |
| Grey `#6E6E73` (text 2, muted) | White | 5.07 | All text |
| Grey | Grey band | 4.66 | All text |
| Grey | Blue tint | 4.67 | All text |
| Grey | Sunken | 4.15 | Large text only; not used for small text |
| Light grey `#86868B` | White / grey band | 3.62 / 3.33 | Large or decorative text only |
| White | Blue `#0071E3` | 4.70 | All text (primary buttons, visitor chat bubble) |
| White | Blue hover `#006EDB` | 4.94 | All text |
| White | Blue pressed `#0062C4` | 5.93 | All text |
| Blue `#0071E3` | White | 4.70 | All text; links still use accent text |
| Blue | Grey band / tint | 4.31 / 4.32 | Large text only |
| Accent text `#0066CC` | White / grey band / tint / sunken | 5.57 / 5.11 / 5.12 / 4.56 | All text (links, eyebrows, labels) |
| Blue hover `#006EDB` | Blue tint | 4.54 | All text (Beta badge, current nav item in the dashboard) |
| Off-white `#F5F5F7` / white | Dark band `#1D1D1F` | 15.46 / 16.83 | All text |
| Off-white / white | Dark card `#333336` | 11.57 / 12.59 | All text |
| On dark 2 `#A1A1A6` | Dark band / dark card | 6.54 / 4.90 | All text |
| Blue lit `#2997FF` | Dark band / black | 5.58 / 6.96 | All text |
| Blue lit | Dark card | 4.18 | Large text and decoration only |
| Success `#047857` | White / grey band | 5.48 / 5.04 | All text |
| Success | Success tint `#ECFDF5` | 5.21 | All text (Available badge) |
| Warning `#B45309` | White / grey band | 5.02 / 4.61 | All text |
| Warning | Warning tint `#FFFBEB` | 4.84 | All text |
| Danger `#B91C1C` | White / grey band | 6.47 / 5.94 | All text |
| Danger | Danger tint `#FEF2F2` | 5.91 | All text |
| White | Danger | 6.47 | All text (counts, destructive fills) |

### Non-text pairings

| Part | On | Ratio | Note |
|---|---|---|---|
| Blue badge | White / grey band | 4.70 / 4.31 | Passes 3:1 |
| White bell | Blue badge | 4.70 | Passes 3:1 |
| Blue focus ring | White / grey band / sunken / tint | 4.70 / 4.31 / 3.85 / 4.32 | Passes 3:1 |
| Blue focus ring | Dark band / dark card | 3.58 / 2.68 | Not used: on the dark band focus rings are white (16.83 / 12.59) |
| Card line `#D2D2D7` | White | 1.51 | Decorative only; never the only sign of state |

### Rules

- **Words on blue are white.** Ink on blue is 3.58:1 and is never used.
- **Blue is the one accent.** Status colours (success, warning, danger) are separate and only mean status; blue never means "Available".
- One primary per view. Links are accent-text blue; everything else stays ink or grey.
- No gradients in the marks or UI chrome. Soft blue washes between page sections are allowed on the website, kept faint and never behind body text. No shadows on cards; one soft lift (`--bl-elev-float`) only for things that float over content. The site header is Apple's translucent bar: `rgba(245, 245, 247, 0.8)` over a saturated blur.

---

## 3. Typography

| Stack | Resolves to | Role |
|---|---|---|
| **Display:** `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", "Helvetica Neue", Arial, sans-serif` | SF Pro Display on Apple devices, Inter elsewhere | Display, headings, big numbers, the name as live text |
| **Text:** `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Helvetica Neue", Arial, sans-serif` | SF Pro Text on Apple devices, Inter elsewhere | Body, UI, labels, buttons |

SF Pro is Apple's licensed font. It may not be self-hosted or served as a webfont on a non-Apple site, so the stack only names it for devices that already have it. Inter (Google Fonts, `wght@400;500;600;700`) is the closest free match and the only webfont loaded, plus IBM Plex Mono in the dashboard. Plus Jakarta Sans is no longer loaded anywhere.

Measured on apple.com (17 September 2026): headlines SF Pro Display 600, 56 / 60 at −0.28 px; subheads 28 / 32; body SF Pro Text 17 / 25 at −0.374 px; buttons 17 px at 400.

The embeddable widget button (`public/embed.js`) runs on customers' own websites and uses the system font on purpose; it loads no fonts.

### Scale

| Style | Web (px / line-height) | App (px / line-height) | Weight | Tracking |
|---|---|---|---|---|
| Display (H1) | 74 / 1.07 | 32 / 1.1 | 600 | −0.015em |
| H2 | 48 / 1.1 | 25 / 1.2 | 600 | −0.01em |
| H3 | 18 / 1.3 | 16 / 1.3 | 600 | −0.015em |
| Lead | 19 / 1.42 | — | 400 | −0.022em |
| Body | 17 / 1.47 | 15 / 1.5 | 400 | −0.022em on the web |
| Small | 14 / 1.55 | 13 / 1.45 | 400 | 0 |
| Button | 17 / 1 | 13 / 1 | 400 | 0 |

Keep line length under about 70 characters for body text. No all-caps labels.

---

## 4. Iconography

- **Line icons** on a 24-unit grid, 2 px stroke, round caps and joins, no fills (phone, microphone, chat, close, send, plus). Blue inside cards on the website, ink in the dashboard, muted at 14 px for meta.
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
| Radius, pills and buttons | 980 px |
| Radius, cards on the website | 18 px, like Apple's tiles |
| Radius, dashboard panels | 14 px |
| Radius, inputs | 12 px |
| Spacing | 4 px base: 4, 8, 12, 16, 24, 32, 48, 64 |
| Card border | 1 px `#D2D2D7` |
| Hairline | 1 px at black 12% |
| Elevation | None on cards. `--bl-elev-float` for menus and the chat dock only |
| Focus ring | Blue, 2 px, 2 px offset (`--bl-focus`). White on the dark band |

### Page rhythm (website)

- **White sections** hold white 18 px tiles with a hairline border and a small blue line icon.
- **One light grey band** (`#F5F5F7`) holds white cards; on the homepage it carries the three set-up steps.
- **One near-black band** (`#1D1D1F`) with `#333336` cards and off-white text; on the homepage it carries "It knows when to stop".
- A faint blue wash may run between sections. Headlines stay left-aligned; the FAQ is a centred accordion.

### Buttons

- **Primary:** blue `#0071E3` pill (980 px radius), white words, 17 px at 400, padding 11 × 21. Hover `#006EDB`, pressed `#0062C4`. One primary per view.
- **Secondary:** white pill with a black-18% line and ink words. Hover fills the blue tint. On the dark band: transparent with a white line and white words.
- **Quiet:** link text in `#0066CC` on light grounds and `#2997FF` on dark, underline on hover.
- **Destructive:** danger text on white; hover fills the danger tint.
- Rows of buttons and badges **wrap** at narrow widths; they never shrink text or scroll sideways (checked at 375 px).
- Minimum touch target 44 px on touch screens.

### Status badges

Use these words and only these meanings. Never show a channel or integration as Available until it works end to end for that customer.

| Badge | Class | Look | Meaning |
|---|---|---|---|
| Available | `.state .state-available` | Success green on success tint, dot (5.21:1) | Live and switched on |
| Beta | `.state .state-beta` | Blue hover on blue tint (4.54:1) | Works, still being tested with real customers |
| Coming soon | `.state .state-soon` | Muted text, black-18% outline (5.07:1 on white) | Not live. Today this includes WhatsApp |
| Request this integration | `.state .state-request` | Ink outline, ink words (16.83:1) | Invites the owner to ask for it |

### Inputs

White field, 1 px black-18% line, 12 px radius, 15–16 px text. Focus: 2 px blue ring. Errors: danger text under the field saying what to fix.

### Website chat widget

- Header: white, the bell button at 36 px, business name in the text stack at 600, "Answered by Belline, AI receptionist"-style meta in muted.
- The business speaks on the grey `#F5F5F7` with ink words; the visitor speaks on blue with white words.
- Send is a round blue button with a white arrow. The microphone is white with an 18% outline.
- Focus ring blue. No shadows inside the panel.
- The floating buttons on customers' sites default to blue with white words and a white bell; the second button is white with a `#D2D2D7` line and a blue icon. The palette a venue picks from starts with Belline blue `#0071E3` and ink `#1D1D1F`; colours a venue already chose are kept. A venue may choose another colour only if its words reach 4.5:1, and the bell then takes the words' colour.

### Dashboard

White ground, grey `#F5F5F7` panels for table heads, side areas and hover rows, hairlines, page titles in the display stack at 600, the current page marked in blue-hover text on the blue tint, primary actions as blue pills. Numbers that are estimates are labelled **Estimate** and never styled like measured results. Sample data is labelled **Sample data**, and its numbers must agree with each other.

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
