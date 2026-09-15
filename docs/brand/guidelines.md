# Belline brand guidelines

Direction C, "The Bell Button". Approved September 2026.

The front-desk bell becomes a button you press: one solid brass badge that is the logo, the app icon, the avatar and the shape of every primary action. Brass is a confident surface, set against oversized Bricolage Grotesque, so Belline looks sure of itself without raising its voice.

**Personality.** The calm, competent front-of-house professional who is always there and never oversteps. Belline is for the owner of a clinic, salon or restaurant in the UAE who wants their phone, website and messages answered properly, in the tools they already use.

**Fixed:** a bell mark, the name Belline, a light interface, English copy, and no gradients, glows, orbs or sound waves.

Source of truth for every value below: `public/brand/tokens.css`. The marketing site (`public/site.css`, inlined at build) and the dashboard (`src/app/globals.css`) both read it.

---

## 1. Logo

### The parts

| Asset | File | Use |
|---|---|---|
| Primary lockup | `public/brand/belline-lockup.svg` | Headers, documents, anywhere the name is introduced |
| Stacked lockup | `public/brand/belline-lockup-stacked.svg` | Square or narrow spaces, sign-in screens |
| Lockup on brass | `public/brand/belline-lockup-on-brass.svg` | On a Bell Brass ground only (ink badge, brass bell) |
| Bell button (mark) | `public/brand/belline-mark.svg` | App icon, avatar, favicon source, the leading edge of the primary button |
| Bell button, inverse | `public/brand/belline-mark-inverse.svg` | Inside brass buttons and on brass grounds |
| Bare bell | `public/brand/belline-bell.svg` | Inline icon beside text, in `currentColor`; never as the logo |
| Wordmark | `public/brand/belline-wordmark.svg`, `-ivory.svg` | Only where the bell button already appears nearby |
| Mono, dark on light | `public/brand/belline-lockup-mono-ink.svg`, `belline-mark-mono-ink.svg` | One-colour printing, fax, embossing, stamps |
| Mono, light on dark | `public/brand/belline-lockup-mono-ivory.svg`, `belline-mark-mono-ivory.svg` | Photography and dark grounds |
| Favicon drawing | `public/brand/belline-favicon.svg` | 16 and 32 px only |

Raster files: `public/brand/png/belline-mark-{16,32,48,180,512,1024}.png`, `public/favicon.ico` (16/32/48), `public/apple-touch-icon.png` (180), `public/brand/png/belline-whatsapp-avatar-640.png`, `public/brand/png/belline-social-avatar-1080.png`, `public/brand/belline-og.png` (1200 × 630).

### Construction

- Badge: a circle of diameter **D**, Bell Brass `#AD8639`.
- Bell, ink `#111111`, drawn in a 48-unit box and seated at 60% of the badge: knob radius 4.2, dome radius 15.5, base 38 × 7 with fully round ends.
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

- Recolour the badge or the bell outside the pairs above. Never put white on brass (3.36:1).
- Add gradients, shadows, glows, outlines, sound waves or motion lines.
- Put the bell outside its badge in a lockup, or rotate, stretch or re-space it.
- Set "Belline" in another typeface or weight, or track it looser than −0.045em.
- Place the primary lockup on photography without a solid ground; use the mono ivory version on dark, even images.

### Avatars

- **WhatsApp profile (640 × 640) and social avatar (1080 × 1080):** full-bleed Bell Brass square, bare ink bell inside the central 50%, so a circular crop never touches the knob or the base (checked at 192 and 40 px).
- WhatsApp is **coming soon**. Any mock-up, preview or caption that shows the WhatsApp avatar must say so. Never caption it as a live business account.
- **App icon and apple-touch-icon:** the same full-bleed square; the platform rounds the corners.

---

## 2. Colour

Contrast is WCAG 2.x, computed from the hex values. AA means 4.5:1 for body text, 3:1 for large text (24 px+, or 19 px bold+) and for UI parts.

### Palette

| Token | Hex | Role |
|---|---|---|
| `--bl-ivory` | `#FCFAF6` | Page ground |
| `--bl-white` | `#FFFFFF` | Panels, cards, inputs |
| `--bl-sand` | `#F6F2EA` | Sunk rows, hovers, table heads |
| `--bl-brass-tint` | `#F3EAD8` | Pills, selected rows, Beta badge |
| `--bl-ink` | `#111111` | Headings, primary text, the bell |
| `--bl-graphite` | `#55504A` | Body text |
| `--bl-stone` | `#6E6961` | Meta text, Coming soon |
| `--bl-brass` | `#AD8639` | Bell Brass: the badge, primary buttons, fills |
| `--bl-brass-desk` | `#7E5E28` | Desk Brass: small brass text and links |
| `--bl-brass-lit` | `#C9A45E` | Brass on ink surfaces |
| `--bl-lagoon` | `#0B6B7A` | States only: Available, success, focus ring |
| `--bl-lagoon-tint` | `#E3F0F1` | Available badge ground |
| `--bl-alert` | `#A33327` | Errors |
| `--bl-alert-tint` | `#F6E4E0` | Error ground |
| `--bl-rule` | ink at 12% | Hairlines |
| `--bl-rule-soft` | ink at 7% | Inner dividers |
| `--bl-rule-strong` | ink at 18% | Outlined badges, quiet inputs |

### Text pairings (all pass AA)

| Text | On | Ratio | Passes for |
|---|---|---|---|
| Ink `#111111` | Ivory | 18.11 | All text |
| Ink | White | 18.88 | All text |
| Ink | Sand | 16.91 | All text |
| Ink | Brass Tint | 15.80 | All text |
| Ink | Bell Brass | 5.62 | All text (primary buttons) |
| Ink | Lagoon Tint | 16.19 | All text |
| Graphite `#55504A` | Ivory | 7.65 | All text |
| Graphite | White | 7.98 | All text |
| Graphite | Sand | 7.14 | All text |
| Graphite | Brass Tint | 6.67 | All text |
| Stone `#6E6961` | Ivory | 5.22 | All text |
| Stone | White | 5.45 | All text |
| Stone | Sand | 4.88 | All text |
| Stone | Brass Tint | 4.56 | All text; keep at 12 px or larger |
| Stone | Lagoon Tint | 4.67 | All text |
| Desk Brass `#7E5E28` | Ivory | 5.72 | All text |
| Desk Brass | White | 5.97 | All text |
| Desk Brass | Sand | 5.34 | All text |
| Desk Brass | Brass Tint | 4.99 | All text (Beta badge) |
| Lagoon `#0B6B7A` | Ivory | 5.93 | All text |
| Lagoon | White | 6.18 | All text |
| Lagoon | Lagoon Tint | 5.30 | All text (Available badge) |
| Alert `#A33327` | Ivory | 6.58 | All text |
| Alert | White | 6.86 | All text |
| Alert | Alert Tint | 5.59 | All text |
| Ivory | Ink | 18.11 | All text (visitor chat bubble) |
| Brass Lit `#C9A45E` | Ink | 8.05 | All text (brass on the call bar) |

### Non-text pairings

| Part | On | Ratio | Note |
|---|---|---|---|
| Bell Brass badge | Ivory | 3.23 | Passes 3:1 for a graphic |
| Bell Brass badge | Ink | 5.62 | Inverse mark |
| Lagoon focus ring | Ivory / White | 5.93 / 6.18 | Passes 3:1 |
| Lagoon focus ring | Ink | 3.06 | Passes 3:1, barely; on ink surfaces prefer Brass Lit (8.05) |

### Rules

- **White never sits on brass** (3.36:1). Words on brass are ink.
- **Lagoon is for states only**: Available, success, focus. It is never decoration or a second brand colour.
- One brass for text: Desk Brass. The old near-duplicates (`#8A672E`, `#8A6432`) are retired.
- No gradients. No shadows on panels; one soft lift (`--bl-elev-float`) only for things that float over content.

---

## 3. Typography

| Face | Weights | Role | Loading |
|---|---|---|---|
| **Bricolage Grotesque** | 700 (650 for H2) | Display, headings, big numbers, the wordmark | Google Fonts, `opsz,wght@12..96,400..800`, `display=swap` |
| **Instrument Sans** | 400, 500, 600 | Body, UI, labels | Google Fonts, `wght@400;500;600;700` |

Why Bricolage Grotesque: its optical-size axis gives big headlines a warm, slightly inky character and settles into a plain grotesk at small sizes, and it is not the default AI-startup face. Fallbacks: `ui-sans-serif, "Segoe UI", Arial, sans-serif`.

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

The site's fluid headline sizes (`clamp()`) sit inside this scale. Keep line length under about 70 characters for body text.

---

## 4. Iconography

- **Line icons** on a 24-unit grid, 2 px stroke, round caps and joins, no fills (phone, calendar, chat, close, send, plus). Ink by default, graphite for secondary rows, stone at 14 px for meta.
- **The bell is the only filled pictogram**, and it only appears as the brand mark or inside the bell button. Do not use it as a generic "notification" icon.
- The chat and WhatsApp buttons on the website use icons drawn in the same hand as the bell (1.5 px stroke at 24 units).
- No sound waves, robots, sparkles, orbs or circuit motifs.
- Third-party logos (Google, Microsoft, Fresha, SevenRooms, OpenTable, Meta) only for integrations that are live, and only as the owner's guidelines allow.

## 5. Photography

- **Real front-of-house moments**: reception counters, a salon chair between clients, a host stand before service, a clinic waiting area in daylight. Warm natural light; brass, wood, stone and linen.
- People are **customers and staff**, busy and at ease, never looking at the camera while wearing a headset. Get written consent; record credits in `public/img/CREDITS.md`.
- Crop so there is calm negative space for a headline; do not put type over busy detail.
- No stock "AI" imagery, no glowing screens, no robots, no dark neon.
- When a photo carries the logo, use the mono ivory lockup on a dark, even area, or put the primary lockup on a solid Ivory band.

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
| Focus ring | Lagoon, 2 px, 2 px offset. Brass Lit on ink surfaces |

### Buttons

- **Primary:** Bell Brass pill, ink words, 600. On the website it carries the bell button (inverse mark) at its leading edge. Hover: ink with ivory words. One primary per view.
- **Secondary:** 1 px ink outline, ink words. Hover fills ink.
- **Quiet:** text in graphite or Desk Brass, underline on hover.
- Rows of buttons and badges **wrap** at narrow widths; they never shrink text or scroll sideways (checked at 375 px).
- Minimum touch target 44 px on touch screens.

### Status badges

Use these words and only these meanings. Never show a channel or integration as Available until it works end to end for that customer.

| Badge | Class | Look | Meaning |
|---|---|---|---|
| Available | `.state .state-available` | Lagoon on Lagoon Tint, dot | Live and switched on |
| Beta | `.state .state-beta` | Desk Brass on Brass Tint | Works, still being tested with real customers |
| Coming soon | `.state .state-soon` | Stone text, 18% ink outline | Not live. Today this includes WhatsApp |
| Request this integration | `.state .state-request` | Ink outline | Invites the owner to ask for it |

### Inputs

White field, 1 px rule, 10 px radius, 13–15 px text. Focus: Lagoon border plus 1 px Lagoon ring. Errors: Alert text under the field saying what to fix.

### Website chat widget

- Header: Ivory, the bell button at 36 px, business name in Instrument Sans 600, "Answered by Belline, AI receptionist"-style meta in stone.
- The business speaks on Sand; the visitor speaks in ink with ivory words.
- Send is a round Bell Brass button with an ink arrow. The microphone is white with an 18% outline.
- Focus ring Lagoon. No shadows inside the panel.
- The floating button on customers' sites defaults to ink with a Brass Lit bell; a venue may choose another colour only if its words reach 4.5:1.

### Dashboard

Ivory ground, white panels with 14 px radius and hairlines, page titles in Bricolage Grotesque. Numbers that are estimates are labelled **Estimate** and never styled like measured results. Sample data is labelled **Sample data**, and its numbers must agree with each other.

---

## 7. Voice and tone

Five attributes:

| Attribute | In practice |
|---|---|
| **Attentive** | Hears the caller out and answers the question asked. |
| **Precise** | Never offers a time the calendar did not return; gives numbers, not adjectives. |
| **Warm** | Sounds like a good receptionist, not a system. Plain words, full sentences. |
| **Discreet** | Hands clinical and sensitive questions to a person, and says it is doing so. |
| **Dependable** | Says what works today and nothing more. |

What Belline is not: an "AI from the future", a developer platform, cute or cartoon, loud or salesy, luxury-snob, dark or crypto, or a second calendar.

### Writing rules

- Sentence case everywhere, including buttons. Actions say what happens: "Connect your business", "Speak to Belline", "Call back".
- Name what the owner cares about (calls, bookings, follow-ups), not how the system works.
- **Honesty is the brand.** Never say or imply that WhatsApp or any integration is live before it is. Use Available / Beta / Coming soon exactly as defined above.
- Estimates are called estimates. "About 3 hours of desk time, assuming 4 minutes a call" is right; "Saved 3 hours" is not.
- Errors say what happened and what to do next, without apology or blame.
- No exclamation marks in product copy. No "revolutionary", "seamless", "magic" or "never miss a call again".

### Examples

| Instead of | Write |
|---|---|
| "Never miss another customer!" | "Someone always answers." |
| "WhatsApp integration included" | "WhatsApp: coming soon" |
| "Seamlessly syncs with all your tools" | "Books into the calendar you already use." |
| "Oops! Something went wrong." | "Belline couldn't check this number just now. Nothing has changed. Try again in a minute." |
| "AI-powered booking engine" | "Belline answers, checks the diary and books the slot, or passes it to your team." |

---

## 8. Working files

- Tokens: `public/brand/tokens.css`
- Logo system and rasters: `public/brand/`
- Name and logo conflict notes: `docs/brand/conflict-check.md`
- HTML version of this document: `docs/brand/guidelines.html`
