# Belline brand guidelines

"The Bell Button", recoloured **Ink + Indigo**. Shape approved September 2026 as Direction C; palette changed from brass to indigo on 15 September 2026.

The front-desk bell becomes a button you press: one solid indigo badge with a white bell that is the logo, the app icon, the avatar and the shape of every primary action. White grounds, ink type and a single indigo accent give Belline the calm, dependable look of business software an owner can trust with their phone line.

**Personality.** The calm, competent front-of-house professional who is always there and never oversteps. Belline is for the owner of a clinic, salon or restaurant in the UAE who wants their phone and website chat answered properly, with their team told what to do next.

**Fixed:** a bell mark inside a round badge, the name Belline in Bricolage Grotesque, a light interface, English copy, and no gradients, glows, orbs or sound waves in the brand marks.

Source of truth for every value below: `public/brand/tokens.css`. The marketing site (`public/site.css`, inlined at build) and the dashboard (`src/app/globals.css`) both read it.

---

## 1. Logo

### The parts

| Asset | File | Use |
|---|---|---|
| Primary lockup | `public/brand/belline-lockup.svg` | Headers, documents, anywhere the name is introduced. Indigo badge, ink name |
| Stacked lockup | `public/brand/belline-lockup-stacked.svg` | Square or narrow spaces, sign-in screens |
| Lockup on indigo | `public/brand/belline-lockup-on-brass.svg` | On an indigo ground only: white badge, indigo bell, white name. The file name is kept from Direction C so links do not break |
| Bell button (mark) | `public/brand/belline-mark.svg` | App icon, avatar, favicon source. White bell on indigo |
| Bell button, inverse | `public/brand/belline-mark-inverse.svg` | Inside indigo buttons and on indigo grounds. Indigo bell on white |
| Bare bell | `public/brand/belline-bell.svg`, `public/mark.svg` | Inline icon beside text, in `currentColor`; never as the logo |
| Bare bell, fixed colour | `public/logo.svg` (ink), `public/logo-dark.svg` (white) | Emails and places that cannot set `currentColor` |
| Wordmark | `public/brand/belline-wordmark.svg` (ink), `-ivory.svg` (white) | Only where the bell button already appears nearby |
| Mono, ink | `public/brand/belline-lockup-mono-ink.svg`, `belline-mark-mono-ink.svg` | One-colour printing, fax, embossing, stamps |
| Mono, white | `public/brand/belline-lockup-mono-ivory.svg`, `belline-mark-mono-ivory.svg` | Photography and dark grounds (file names kept; the colour is now white) |
| Favicon drawing | `public/brand/belline-favicon.svg`, `public/icon.svg` | 16 and 32 px, and the SVG favicon |

Raster files: `public/brand/png/belline-mark-{16,32,48,180,512,1024}.png`, `public/favicon.ico` (16/32/48), `public/apple-touch-icon.png` (180), `public/brand/png/belline-whatsapp-avatar-640.png`, `public/brand/png/belline-social-avatar-1080.png`, `public/brand/belline-og.png` (1200 × 630).

### Construction

- Badge: a circle of diameter **D**, Indigo `#4F46E5`.
- Bell, white `#FFFFFF`, drawn in a 48-unit box and seated at 60% of the badge: knob radius 4.2, dome radius 15.5, base 38 × 7 with fully round ends.
- In the favicon drawing (16 px) the knob is squared to 2 px, with 1 px gaps and a 2 px base, so it stays crisp on a pixel grid.

### Clear space and proportions

- **x = badge radius ÷ 2** (D ÷ 4).
- Keep **1x** clear on every side of any lockup.
- Gap from badge to name = **1x**. Name cap size follows a name font size of **0.72 × D**.
- Stacked lockup: badge 52, gap 8, name 28 (scale together).

### Minimum sizes

| Form | Minimum |
|---|---|
| Horizontal lockup | 20 px badge |
| Stacked lockup | 24 px badge |
| Bell button alone | 16 px (use the favicon drawing below 32 px) |
| Bare bell | 12 px |
| Wordmark | 14 px type, about 48 px wide |

### Do not

- Recolour the badge or the bell outside the pairs above. Words and bells on indigo are white; never ink on indigo (2.82:1).
- Add gradients, shadows, glows, outlines, sound waves or motion lines.
- Put the bell outside its badge in a lockup, or rotate, stretch or re-space it.
- Set "Belline" in another typeface or weight, or track it looser than −0.045em.
- Place the primary lockup on photography without a solid ground; use the mono white version on dark, even images.

### Avatars

- **WhatsApp profile (640 × 640) and social avatar (1080 × 1080):** full-bleed indigo square, white bell inside the central 50%, so a circular crop never touches the knob or the base (checked at 160 and 40 px).
- WhatsApp is **coming soon**. Any mock-up, preview or caption that shows the WhatsApp avatar must say so. Never caption it as a live business account.
- **App icon and apple-touch-icon:** the same full-bleed square; the platform rounds the corners.
- **OG image:** white ground, ink headline, indigo mark. It names phone and website chat only.

---

## 2. Colour

Contrast is WCAG 2.x, computed from the hex values. AA means 4.5:1 for body text, 3:1 for large text (24 px+, or 19 px bold+) and for UI parts such as focus rings and input borders.

### Palette

| Token | Hex | Role |
|---|---|---|
| `--bl-ground` | `#FFFFFF` | Page ground, panels, cards, inputs |
| `--bl-surface` | `#F6F7FB` | Soft panels, table heads, the chat's business bubble |
| `--bl-sunken` | `#EEF0F6` | Hover and pressed rows |
| `--bl-border` / `--bl-rule` | `#E5E7EB` / ink at 12% | Hairlines |
| `--bl-rule-soft` / `--bl-rule-strong` | ink at 7% / 18% | Inner dividers / outlined badges |
| `--bl-ink-900` | `#111827` | Headings, primary text, mono marks |
| `--bl-text-2` | `#374151` | Body and secondary text |
| `--bl-muted` | `#636A77` | Meta text, Coming soon |
| `--bl-indigo` | `#4F46E5` | Accent: primary buttons, links, the badge, focus ring |
| `--bl-indigo-hover` | `#4338CA` | Primary hover; indigo text on the tint (Beta) |
| `--bl-indigo-pressed` | `#3730A3` | Primary pressed |
| `--bl-indigo-tint` | `#EEF2FF` | Selected rows, current nav item, Beta badge |
| `--bl-indigo-line` | `#C7D2FE` | Decorative indigo hairline; never text |
| `--bl-indigo-lit` | `#A5B4FC` | Indigo on ink surfaces (call screen, sales console) |
| `--bl-success` / `-tint` | `#047857` / `#ECFDF5` | Available, confirmed |
| `--bl-warning` / `-tint` | `#B45309` / `#FFFBEB` | Deposits due, handovers waiting |
| `--bl-danger` / `-tint` | `#B91C1C` / `#FEF2F2` | Errors, destructive actions |

**Muted was adjusted.** The brief's `#6B7280` passes on white (4.83) and only just on the soft panel (4.52), but fails on the hover surface (4.24) and the indigo tint (4.32). `#636A77` is a step darker and passes on all four (5.44 / 5.08 / 4.78 / 4.87).

The Direction C names (`--bl-ivory`, `--bl-sand`, `--bl-brass`, `--bl-brass-desk`, `--bl-brass-tint`, `--bl-brass-lit`, `--bl-lagoon`, `--bl-alert`, `--bl-stone`, `--bl-graphite`, `--bl-rule-brass`) remain in `tokens.css` as aliases of the values above, so older CSS keeps working. New code uses the new names.

### Text pairings (all pass AA)

| Text | On | Ratio | Passes for |
|---|---|---|---|
| Ink `#111827` | Ground `#FFFFFF` | 17.74 | All text |
| Ink | Surface `#F6F7FB` | 16.57 | All text |
| Ink | Sunken `#EEF0F6` | 15.57 | All text |
| Ink | Indigo tint `#EEF2FF` | 15.86 | All text |
| Text 2 `#374151` | Ground | 10.31 | All text |
| Text 2 | Surface | 9.63 | All text |
| Text 2 | Sunken | 9.05 | All text |
| Text 2 | Indigo tint | 9.22 | All text |
| Muted `#636A77` | Ground | 5.44 | All text |
| Muted | Surface | 5.08 | All text |
| Muted | Sunken | 4.78 | All text |
| Muted | Indigo tint | 4.87 | All text |
| White | Indigo `#4F46E5` | 6.29 | All text (primary buttons, visitor chat bubble) |
| White | Indigo hover `#4338CA` | 7.90 | All text |
| White | Indigo pressed `#3730A3` | 9.93 | All text |
| Indigo `#4F46E5` | Ground | 6.29 | All text (links) |
| Indigo | Surface | 5.87 | All text |
| Indigo | Sunken | 5.52 | All text |
| Indigo | Indigo tint | 5.62 | All text |
| Indigo hover `#4338CA` | Indigo tint | 7.07 | All text (Beta badge, current nav item) |
| Success `#047857` | Ground | 5.48 | All text |
| Success | Success tint `#ECFDF5` | 5.21 | All text (Available badge) |
| Warning `#B45309` | Ground | 5.02 | All text |
| Warning | Warning tint `#FFFBEB` | 4.84 | All text |
| Danger `#B91C1C` | Ground | 6.47 | All text |
| Danger | Danger tint `#FEF2F2` | 5.91 | All text |
| White | Danger | 6.47 | All text (counts, destructive fills) |
| White | Ink | 17.74 | All text (call screen, sales console) |
| Indigo lit `#A5B4FC` | Ink | 8.90 | All text |

### Non-text pairings

| Part | On | Ratio | Note |
|---|---|---|---|
| Indigo badge | Ground / Surface | 6.29 / 5.87 | Passes 3:1 |
| White bell | Indigo badge | 6.29 | Passes 3:1 |
| Indigo focus ring | Ground / Surface / Sunken | 6.29 / 5.87 / 5.52 | Passes 3:1 |
| Indigo focus ring | Ink | 2.82 | Fails; on ink surfaces use Indigo lit (8.90) |
| Indigo line `#C7D2FE` | Ground | 1.49 | Decorative only; never the only sign of state |

### Rules

- **Words on indigo are white.** Ink on indigo is 2.82:1 and is never used.
- **Indigo is the one accent.** Status colours (success, warning, danger) are separate and only mean status; indigo never means "Available".
- One primary per view. Links are indigo; everything else stays ink, text 2 or muted.
- No gradients in the marks or UI chrome. No shadows on panels; one soft lift (`--bl-elev-float`) only for things that float over content.

---

## 3. Typography

| Face | Weights | Role | Loading |
|---|---|---|---|
| **Bricolage Grotesque** | 700 (650 for H2) | Display, headings, big numbers, the wordmark | Google Fonts, `opsz,wght@12..96,400..800`, `display=swap` |
| **Instrument Sans** | 400, 500, 600 | Body, UI, labels | Google Fonts, `wght@400;500;600;700` |

Bricolage Grotesque's optical-size axis gives big headlines character and settles into a plain grotesk at small sizes. Fallbacks: `ui-sans-serif, "Segoe UI", Arial, sans-serif`.

The embeddable widget button (`public/embed.js`) runs on customers' own websites and uses the system font on purpose; it loads no fonts.

### Scale

| Style | Web (px / line-height) | App (px / line-height) | Tracking |
|---|---|---|---|
| Display | 108 / 0.94 | 40 / 1.0 | −0.045em |
| H1 | 56 / 1.0 | 30 / 1.1 | −0.035em |
| H2 | 32 / 1.1 | 22 / 1.2 | −0.02em |
| Body | 18 / 1.55 | 15 / 1.5 | 0 |
| Small | 14 / 1.5 | 13 / 1.45 | 0 |
| Label | 12 / 1.2, 600, uppercase | 11 / 1.2, 600, uppercase | +0.08em |

Keep line length under about 70 characters for body text.

---

## 4. Iconography

- **Line icons** on a 24-unit grid, 2 px stroke, round caps and joins, no fills (phone, calendar, chat, close, send, plus). Ink by default, text 2 for secondary rows, muted at 14 px for meta.
- **The bell is the only filled pictogram**, and it only appears as the brand mark or inside the bell button. Do not use it as a generic "notification" icon.
- No sound waves, robots, sparkles, orbs or circuit motifs.
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
| Radius, panels and cards | 14 px |
| Radius, inputs | 10 px |
| Spacing | 4 px base: 4, 8, 12, 16, 24, 32, 48, 64 |
| Hairline | 1 px at ink 12% |
| Elevation | None on panels. `--bl-elev-float` for menus and the chat dock only |
| Focus ring | Indigo, 2 px, 2 px offset (`--bl-focus`). Indigo lit on ink surfaces |

### Buttons

- **Primary:** indigo pill, white words, 600. Hover `#4338CA`, pressed `#3730A3`. One primary per view.
- **Secondary:** white with a 1 px hairline, ink words. Hover fills the sunken surface.
- **Quiet:** indigo link text, underline on hover.
- **Destructive:** danger text on white; hover fills the danger tint.
- Rows of buttons and badges **wrap** at narrow widths; they never shrink text or scroll sideways (checked at 375 px).
- Minimum touch target 44 px on touch screens.

### Status badges

Use these words and only these meanings. Never show a channel or integration as Available until it works end to end for that customer.

| Badge | Class | Look | Meaning |
|---|---|---|---|
| Available | `.state .state-available` | Success green on success tint, dot (5.21:1) | Live and switched on |
| Beta | `.state .state-beta` | Indigo hover on indigo tint (7.07:1) | Works, still being tested with real customers |
| Coming soon | `.state .state-soon` | Muted text, 18% ink outline (5.44:1) | Not live. Today this includes WhatsApp |
| Request this integration | `.state .state-request` | Ink outline, ink words (17.74:1) | Invites the owner to ask for it |

### Inputs

White field, 1 px rule, 10 px radius, 13–15 px text. Focus: indigo border plus 1 px indigo ring. Errors: danger text under the field saying what to fix.

### Website chat widget

- Header: white, the bell button at 36 px, business name in Instrument Sans 600, "Answered by Belline, AI receptionist"-style meta in muted.
- The business speaks on the soft surface `#F6F7FB` with ink words; the visitor speaks on indigo with white words.
- Send is a round indigo button with a white arrow. The microphone is white with an 18% outline.
- Focus ring indigo. No shadows inside the panel.
- The floating buttons on customers' sites default to indigo with white words and a white bell; the second button is white with an indigo icon. A venue may choose another colour only if its words reach 4.5:1, and the bell then takes the words' colour.

### Dashboard

White ground, soft `#F6F7FB` panels for table heads and side areas, hairlines, page titles in Bricolage Grotesque, the current page marked in indigo on the indigo tint. Numbers that are estimates are labelled **Estimate** and never styled like measured results. Sample data is labelled **Sample data**, and its numbers must agree with each other.

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

- Sentence case everywhere, including buttons. Actions say what happens: "Connect your business", "Speak to Belline", "Call back".
- Name what the owner cares about (calls, enquiries, follow-ups), not how the system works.
- **Honesty is the brand.** Never say or imply that WhatsApp, a calendar or any integration is live before it is. Use Available / Beta / Coming soon exactly as defined above.
- Estimates are called estimates. "About 3 hours of desk time, assuming 4 minutes a call" is right; "Saved 3 hours" is not.
- Errors say what happened and what to do next, without apology or blame.
- No exclamation marks in product copy. No "revolutionary", "seamless", "magic" or "never miss a call again".

### Examples

| Instead of | Write |
|---|---|
| "Never miss another customer!" | "Someone always answers." |
| "WhatsApp integration included" | "WhatsApp: coming soon" |
| "Seamlessly syncs with all your tools" | "Google Calendar: coming soon" |
| "Oops! Something went wrong." | "Belline couldn't check this number just now. Nothing has changed. Try again in a minute." |
| "AI-powered booking engine" | "Belline answers, takes the details and tells your team what to do next." |

---

## 8. Working files

- Tokens: `public/brand/tokens.css`
- Logo system and rasters: `public/brand/`
- Name and logo conflict notes: `docs/brand/conflict-check.md`
- HTML version of this document: `docs/brand/guidelines.html`
