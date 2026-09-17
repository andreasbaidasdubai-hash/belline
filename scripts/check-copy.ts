/**
 * No allowance figure anywhere but the catalogue's.
 *
 * Every plan's pools live in `src/lib/billing/plans.ts`, and everything a
 * customer reads is supposed to be generated from them: the pricing block and
 * the FAQ on the website, the built site, Belline's own seeded answers, and
 * what Belle says when she quotes. "Supposed to" is the problem — the numbers
 * were raised once and four of those surfaces had to be found by hand.
 *
 * So this reads the shipped copy back and fails if it states a voice-minute or
 * text-conversation figure the catalogue does not. It knows nothing about what
 * the numbers should be; it only insists that every one of them came from the
 * catalogue, in digits ("300 voice minutes") or in words ("three hundred"),
 * which is how Belle says them aloud.
 *
 *   npm run check:copy
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-copy-"));

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const { PACKS, PRODUCTS, TRIAL, publicLines, sellable } = await import("../src/lib/billing/plans");
const { numberWords, overLimitSentence, packsSentence, priceAnswer, trialAnswer, trialSentence, usageAnswer } =
  await import("../src/lib/billing/speak");
const { bellineVenue } = await import("../src/lib/seed-belline");

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// What the catalogue actually states
// ---------------------------------------------------------------------------

/**
 * Every unit figure the catalogue itself carries: the pools and per-channel
 * allowances of everything still sold or quoted, the packs, and the trial.
 * Legacy products are left out on purpose — a September bundle's allowance
 * appearing in today's copy is exactly the drift this is looking for.
 */
const CATALOGUE_FIGURES = new Set<number>([
  ...PRODUCTS.filter((p) => p.kind !== "legacy").flatMap((p) => [
    ...Object.values(p.pools ?? {}),
    ...Object.values(p.allowances),
  ]).filter((n): n is number => typeof n === "number"),
  ...PACKS.map((p) => p.units),
  TRIAL.minutes,
  TRIAL.conversations,
  // "Each video minute uses 2.5 voice minutes": the ratio, from the pricing generator (plans.ts after merge).
  (await import("./site-pricing")).VIDEO_VOICE_MINUTE_RATIO,
]);

/** The same figures as they are ever written: 2000, "2,000", "two thousand". */
const ALLOWED = new Set<string>(
  [...CATALOGUE_FIGURES].flatMap((n) => (Number.isInteger(n) ? [String(n), n.toLocaleString("en-GB"), numberWords(n)] : [String(n)])),
);

const UNIT = "(?:voice min(?:ute)?s?|text conversations)";
/** "750 text conversations", "1,300 voice minutes" — a figure written in digits. */
const DIGITS = new RegExp(`(?<![\\d.])(\\d[\\d,]*(?:\\.\\d+)?)\\s+(?:extra\\s+)?${UNIT}`, "gi");
/** The vocabulary numberWords builds a spoken figure out of. */
const WORD = /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and)(?:-(?:one|two|three|four|five|six|seven|eight|nine))?$/i;
/** Whatever words run up to a unit: "with three hundred voice minutes". */
const WORDS = new RegExp(`([A-Za-z][A-Za-z\\s-]{0,60}?)\\s+(?:extra\\s+)?${UNIT}`, "gi");

/** Every figure a piece of copy states against a unit, digits and words alike. */
function figuresIn(text: string): string[] {
  const found: string[] = [];
  for (const [, digits] of text.matchAll(DIGITS)) found.push(digits);
  for (const [, before] of text.matchAll(WORDS)) {
    // The maximal run of number words immediately before the unit. Anything
    // else ("your voice minutes", "its text conversations") states no figure.
    const words = before.trim().split(/\s+/);
    let from = words.length;
    while (from > 0 && WORD.test(words[from - 1])) from--;
    const spoken = words.slice(from).join(" ");
    // A trailing "and" belongs to the sentence, not to the number.
    const trimmed = spoken.replace(/^and\s+/i, "").replace(/\s+and$/i, "");
    if (trimmed && !/^and$/i.test(trimmed)) found.push(trimmed);
  }
  return found;
}

/** Everything the copy says, checked figure by figure against the catalogue. */
function assertFromCatalogue(where: string, text: string) {
  const strays = [...new Set(figuresIn(text))].filter((f) => !ALLOWED.has(f));
  assert.deepEqual(
    strays,
    [],
    `${where} states ${strays.map((s) => `"${s}"`).join(", ")}, which the catalogue does not. ` +
      `The catalogue's figures are ${[...CATALOGUE_FIGURES].sort((a, b) => a - b).join(", ")}. ` +
      "Change plans.ts, then run npm run pricing and npm run site.",
  );
}

console.log("\n\x1b[1mThe figures the catalogue states\x1b[0m\n");

test("it knows a stray figure when it sees one, in digits and in words", () => {
  // The guard's own guard: a check that cannot fail protects nothing.
  assert.deepEqual(figuresIn("1,300 text conversations a month"), ["1,300"]);
  assert.deepEqual(figuresIn("with two hundred and fifty voice minutes"), ["two hundred and fifty"]);
  assert.deepEqual(figuresIn("your voice minutes are used up"), []);
  assert.throws(() => assertFromCatalogue("a made-up page", "9,999 voice minutes a month"));
});

console.log("\n\x1b[1mWhat the website ships\x1b[0m\n");

const pages = fs
  .readdirSync(path.join(ROOT, "public"))
  .filter((f) => f.endsWith(".html"))
  .map((f) => ({ where: `public/${f}`, html: fs.readFileSync(path.join(ROOT, "public", f), "utf8") }));

test(`every allowance on the ${pages.length} public pages is the catalogue's`, () => {
  assert.ok(pages.length > 0, "no public pages were read");
  for (const { where, html } of pages) assertFromCatalogue(where, html);
});

// The built site is generated by `npm run site` and is not in the repo, so it
// is checked when it is there and skipped when it is not — never silently
// passed off as checked.
const built = path.join(ROOT, "site");
const siteFiles = fs.existsSync(built)
  ? fs
      .readdirSync(built, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".html"))
      .map((e) => path.join(e.parentPath ?? built, e.name))
  : [];

test(
  siteFiles.length
    ? `every allowance in the ${siteFiles.length} built pages under site/ is the catalogue's`
    : "site/ has not been built — run npm run site to check it too (skipped)",
  () => {
    for (const file of siteFiles) {
      assertFromCatalogue(path.relative(ROOT, file), fs.readFileSync(file, "utf8"));
    }
  },
);

console.log("\n\x1b[1mWhat Belline and Belle say\x1b[0m\n");

test("Belline's own seeded answers and policies state only the catalogue's figures", () => {
  assertFromCatalogue("src/lib/seed-belline.ts", JSON.stringify(bellineVenue));
});

test("every sentence the catalogue generates for a page or a quote states only its own figures", () => {
  const sentences: [string, string][] = [
    ["priceAnswer", priceAnswer("AE")],
    ["trialAnswer", trialAnswer()],
    ["usageAnswer", usageAnswer("AE")],
    ["trialSentence", trialSentence()],
    ["packsSentence", packsSentence()],
    ["overLimitSentence", overLimitSentence()],
  ];
  for (const [where, text] of sentences) assertFromCatalogue(where, text);
});

test("the lines Belle quotes from each plan's card state that plan's own allowances", () => {
  for (const product of sellable("AE")) {
    const lines = publicLines(product).join(" | ");
    assertFromCatalogue(`publicLines(${product.id})`, lines);
    // And the plan's own pools are actually in there, so a card that quietly
    // stopped naming an allowance cannot pass by saying nothing.
    for (const units of Object.values(product.pools ?? {})) {
      assert.ok(
        lines.includes(units.toLocaleString("en-GB")),
        `${product.id} no longer shows its ${units} allowance: ${lines}`,
      );
    }
  }
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;
