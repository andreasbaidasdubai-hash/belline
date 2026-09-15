/**
 * The rules a signup is held to, in one place the browser can import too.
 *
 * The checkout form once said "at least twelve characters" while the server
 * wanted ten and quietly refused anything containing "belline". A customer
 * who follows the hint and is still refused does not try a third time. So
 * the hint, the input's `minLength` and the server's check all read from
 * here, and check:signup fails if they drift.
 *
 * Pure data and pure functions: no `node:*`, no store.
 */

import type { Vertical } from "./types";

export const PASSWORD_MIN_LENGTH = 10;

/** Refused anywhere inside a password, case-insensitively. */
export const PASSWORD_COMMON_WORDS = ["password", "12345678", "qwerty", "belline", "letmein"] as const;

/** What the form says under the password field. Built from the rule, never typed twice. */
export const PASSWORD_HINT =
  `At least ${PASSWORD_MIN_LENGTH} characters, not only digits, and no common word ` +
  `such as "password" or "belline". A short sentence works well.`;

/** Rejects the passwords that make a breach inevitable, and nothing more. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (/^\d+$/.test(password)) return "Digits alone are too easy to guess.";
  if (PASSWORD_COMMON_WORDS.some((c) => password.toLowerCase().includes(c))) {
    return "That contains a very common word. Pick something else.";
  }
  return null;
}

/**
 * What kind of business, as an optional prefill.
 *
 * Belline is for any business that takes calls or bookings, so this is not a
 * gate: leaving it empty is a valid answer and gets the appointment diary,
 * which is what most businesses keep. A restaurant is the one case where the
 * engine differs (a table is not an appointment).
 */
export const TRADES: { value: Vertical; label: string }[] = [
  { value: "salon", label: "Salon, spa or beauty" },
  { value: "clinic", label: "Clinic or dental practice" },
  { value: "restaurant", label: "Restaurant or café" },
];

const TRADE_ALIASES: Record<string, Vertical> = {
  salon: "salon",
  salons: "salon",
  spa: "salon",
  beauty: "salon",
  clinic: "clinic",
  clinics: "clinic",
  dental: "clinic",
  restaurant: "restaurant",
  restaurants: "restaurant",
  cafe: "restaurant",
};

/** A landing page's `?trade=`, or "" when it names nothing we know. Never a default. */
export function tradeFromParam(value: unknown): Vertical | "" {
  if (typeof value !== "string") return "";
  return TRADE_ALIASES[value.trim().toLowerCase()] ?? "";
}
