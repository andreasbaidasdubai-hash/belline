import type { EmbedAppearance } from "./types";
import { copy, type CopyLanguage } from "./customer-copy";

/**
 * The widget's look — pure, and safe in the browser.
 *
 * Split from embed.ts because the editor renders a live preview from these
 * same rules, and embed.ts reaches for node:crypto and the store, neither of
 * which belongs in a client bundle.
 */

// ---------------------------------------------------------------------------

/**
 * The palette a venue may pick the filled button from, by name.
 *
 * Six, not a colour wheel: each pairs with white or ink text at 4.5:1.
 * Blue is Belline's own and the default. It keeps the key "indigo" because
 * venues saved that name before the blue recolour, and "brass" stays valid for
 * the same reason. A venue with a brand colour outside these can give a hex, and
 * the contrast rule below decides whether it is allowed.
 */
export const EMBED_PALETTE: Record<string, string> = {
  indigo: "#0071E3",
  ink: "#1D1D1F",
  brass: "#7E5E28",
  forest: "#2F4A3A",
  navy: "#1F2E4A",
  wine: "#5E2434",
};

const PAPER = "#FFFFFF";
const INK = "#1D1D1F";

/** Guidelines, in numbers. */
export const APPEARANCE_RULES = {
  /** A button, not a sentence. */
  labelMaxChars: 24,
  /** WCAG AA for the words on the button. */
  minContrast: 4.5,
} as const;

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The accent as a hex, whether it was given by name or by value. Null if neither. */
export function accentHex(accent: string | undefined): string | null {
  if (!accent) return EMBED_PALETTE.indigo;
  const named = EMBED_PALETTE[accent.toLowerCase()];
  if (named) return named;
  const hex = accent.trim();
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toUpperCase() : null;
}

/** Paper or ink, whichever reads better on the accent. */
export function textOn(accent: string): string {
  return contrastRatio(accent, PAPER) >= contrastRatio(accent, INK) ? PAPER : INK;
}

export type AppearanceProblem = { field: keyof EmbedAppearance; message: string };

/**
 * The venue's choices, checked against the guidelines.
 *
 * Returns the cleaned appearance, or the first thing wrong with it in words
 * a business owner can act on. Unknown fields are dropped; an absent field
 * means "the default", never an error.
 */
export function parseAppearance(
  raw: unknown,
): { ok: true; appearance: EmbedAppearance } | { ok: false; problem: AppearanceProblem } {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: EmbedAppearance = {};

  for (const field of ["voiceLabel", "chatLabel", "whatsappLabel"] as const) {
    const v = input[field];
    if (v === undefined || v === null || v === "") continue;
    const text = String(v).replace(/\s+/g, " ").trim();
    if (text.length > APPEARANCE_RULES.labelMaxChars) {
      return { ok: false, problem: { field, message: `Keep it under ${APPEARANCE_RULES.labelMaxChars} characters — it is a button, not a sentence.` } };
    }
    if (/https?:|www\.|[<>{}]/i.test(text)) {
      return { ok: false, problem: { field, message: "Words only — no links or code on a button." } };
    }
    if (text) out[field] = text;
  }

  if (input.accent !== undefined && input.accent !== null && input.accent !== "") {
    const hex = accentHex(String(input.accent));
    if (!hex) {
      return { ok: false, problem: { field: "accent", message: "Pick a colour from the palette, or give a hex like #2F4A3A." } };
    }
    const contrast = Math.max(contrastRatio(hex, PAPER), contrastRatio(hex, INK));
    if (contrast < APPEARANCE_RULES.minContrast) {
      // Only a mid-tone fails: anything dark takes paper text, anything pale
      // takes ink. What cannot be read is a colour that is neither.
      return { ok: false, problem: { field: "accent", message: "That colour doesn't leave enough contrast for the words on the button. Try a deeper or a lighter shade." } };
    }
    out.accent = EMBED_PALETTE[String(input.accent).toLowerCase()] ? String(input.accent).toLowerCase() : hex;
  }

  if (input.shape !== undefined) {
    if (input.shape !== "pill" && input.shape !== "round") {
      return { ok: false, problem: { field: "shape", message: "Pill or round." } };
    }
    out.shape = input.shape;
  }
  if (input.corner !== undefined) {
    if (input.corner !== "right" && input.corner !== "left") {
      return { ok: false, problem: { field: "corner", message: "Right or left." } };
    }
    out.corner = input.corner;
  }
  if (typeof input.whatsapp === "boolean") out.whatsapp = input.whatsapp;

  // "logo" is accepted whether or not a logo is uploaded yet: this is pure and
  // cannot see the venue, and a removed logo must not turn a saved choice into
  // an error. resolveAppearance draws the bell until there is a logo to draw.
  if (input.buttonMark !== undefined) {
    if (input.buttonMark !== "bell" && input.buttonMark !== "logo") {
      return { ok: false, problem: { field: "buttonMark", message: "The bell or your logo." } };
    }
    out.buttonMark = input.buttonMark;
  }
  if (input.ring !== undefined) {
    if (typeof input.ring !== "boolean") {
      return { ok: false, problem: { field: "ring", message: "Ringing is on or off." } };
    }
    out.ring = input.ring;
  }

  return { ok: true, appearance: out };
}

/**
 * The appearance with every default filled in and the colours resolved — what the widget is told.
 * `language` is the venue's: a German venue that never wrote its own labels gets German ones.
 * `logoUrl` is the venue's uploaded logo (logo.ts `logoUrlFor`), or null when there is none.
 */
export function resolveAppearance(
  appearance: EmbedAppearance | undefined,
  language: CopyLanguage = "en",
  logoUrl: string | null = null,
) {
  const accent = accentHex(appearance?.accent) ?? EMBED_PALETTE.indigo;
  const text = textOn(accent);
  // The logo only where the owner chose it *and* there is one. A choice
  // outliving its logo draws the bell rather than an empty circle.
  const buttonMark: "bell" | "logo" = appearance?.buttonMark === "logo" && logoUrl ? "logo" : "bell";
  return {
    voiceLabel: appearance?.voiceLabel ?? (language === "en" ? "Talk to us" : copy(language, "embed.voice_label")),
    chatLabel: appearance?.chatLabel ?? (language === "en" ? "Chat with us" : copy(language, "embed.chat_label")),
    whatsappLabel: appearance?.whatsappLabel ?? (language === "en" ? "WhatsApp us" : copy(language, "embed.whatsapp_label")),
    accent,
    accentText: text,
    // The mark on the filled button takes the words' colour: white on indigo and
    // other deep accents, ink on pale ones.
    accentMark: text,
    shape: appearance?.shape ?? "pill",
    corner: appearance?.corner ?? "right",
    whatsapp: appearance?.whatsapp ?? true,
    buttonMark,
    // Sent only when it will be drawn: the widget has no other use for it.
    logoUrl: buttonMark === "logo" ? logoUrl : null,
    ring: appearance?.ring ?? false,
  };
}

