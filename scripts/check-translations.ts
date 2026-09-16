/**
 * The German pages keep up with the English ones.
 *
 * Each German source in public/ is a translation of an English page, and
 * records which version of it: `<!-- translated-from: sha256 … -->`, a hash
 * of the English page's translatable content (its words and markup, without
 * comments, structured data or the blocks the build generates from the
 * catalogue and the flags). Change the English page and this fails until
 * somebody has updated the German and recorded the new hash, so an English
 * fix cannot silently leave three German pages saying the old thing.
 *
 * It also holds the two pages to the same skeleton: the same sections with
 * the same ids in the same order, the same generated blocks, the same FAQ
 * length, and the same legal placeholders.
 *
 *   npm run check:translations
 *   npm run translations:hash      after updating a German page: record the English hash
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

/** English source → German source. */
export const TRANSLATIONS: Record<string, string> = {
  "landing.html": "landing.de.html",
  "privacy.html": "privacy.de.html",
  "terms.html": "terms.de.html",
};

const MARKER = /<!-- translated-from: sha256 ([0-9a-f]{64}|pending) -->/;

/**
 * What a translator translates: the page without its comments, its structured
 * data, its hreflang lines, or the text of anything generated (the pricing,
 * the integrations strip, the picker, every data-gen element). Line endings
 * and runs of whitespace are normalised, so re-wrapping a paragraph or a
 * Windows checkout does not count as a change.
 */
export function translatableContent(html: string): string {
  return html
    .replace(/\r\n/g, "\n")
    .replace(/<!-- (pricing|integrations|locale):start[\s\S]*?<!-- \1:end -->/g, "<!-- $1 -->")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "")
    .replace(/<link rel="alternate" hreflang="[^"]*" href="[^"]*">/g, "")
    .replace(/(<(span|p) class="gen" data-gen="[^"]+">)[^<]*(<\/\2>)/g, "$1$3")
    .replace(/\s+/g, " ")
    .trim();
}

export function translationHash(english: string): string {
  return crypto.createHash("sha256").update(translatableContent(english)).digest("hex");
}

const read = (file: string) => fs.readFileSync(path.join(PUBLIC, file), "utf8");

if (process.argv.includes("--update")) {
  for (const [english, german] of Object.entries(TRANSLATIONS)) {
    const html = read(german);
    if (!MARKER.test(html)) throw new Error(`public/${german} has no <!-- translated-from: sha256 … --> line to update.`);
    const next = html.replace(MARKER, `<!-- translated-from: sha256 ${translationHash(read(english))} -->`);
    if (next !== html) fs.writeFileSync(path.join(PUBLIC, german), next, "utf8");
    console.log(`  public/${german}: translated from public/${english} as it is now.`);
  }
  process.exit(0);
}

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

const sectionIds = (html: string) => [...html.matchAll(/<section\b[^>]*?\sid="([^"]+)"/g)].map((m) => m[1]);
const sectionCount = (html: string) => (html.match(/<section\b/g) ?? []).length;
const genKeys = (html: string) => new Set([...html.matchAll(/data-gen="([^"]+)"/g)].map((m) => m[1]));
const legalKeys = (html: string) => [...html.matchAll(/data-legal="([^"]+)"/g)].map((m) => m[1]).sort();
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

console.log("\n\x1b[1mThe German pages keep up with the English ones\x1b[0m\n");

test("the translatable content ignores comments, generated blocks and line endings, and sees a changed sentence", () => {
  const page = '<p>Hello there.</p>\n<!-- pricing:start x -->A<!-- pricing:end -->\n<span class="gen" data-gen="k">one</span>';
  assert.equal(translationHash(page), translationHash(page.replace(/\n/g, "\r\n").replace("A", "B").replace(">one<", ">two<")));
  assert.notEqual(translationHash(page), translationHash(page.replace("Hello there.", "Hello, there.")));
});

for (const [english, german] of Object.entries(TRANSLATIONS)) {
  const en = read(english);
  const de = read(german);

  test(`public/${german} was translated from public/${english} as it is now`, () => {
    const recorded = MARKER.exec(de)?.[1];
    assert.ok(recorded, `public/${german} has no <!-- translated-from: sha256 … --> line`);
    assert.equal(
      recorded,
      translationHash(en),
      `public/${english} has changed since public/${german} was translated. Update the German to match, then run ` +
        "`npm run translations:hash` to record the new hash.",
    );
  });

  test(`public/${german} has the same sections, with the same ids in the same order`, () => {
    assert.deepEqual(sectionIds(de), sectionIds(en));
    assert.equal(sectionCount(de), sectionCount(en));
  });

  test(`public/${german} carries every generated slot and marker public/${english} has`, () => {
    for (const key of genKeys(en)) assert.ok(genKeys(de).has(key), `data-gen="${key}" is missing`);
    for (const marker of ["pricing", "integrations", "locale"]) {
      assert.equal(de.includes(`<!-- ${marker}:start`), en.includes(`<!-- ${marker}:start`), `<!-- ${marker}:start --> differs`);
      assert.equal(de.includes(`<!-- ${marker}:end -->`), en.includes(`<!-- ${marker}:end -->`), `<!-- ${marker}:end --> differs`);
    }
    assert.deepEqual(legalKeys(de), legalKeys(en), "the data-legal placeholders differ");
  });

  test(`public/${german} is German, with a canonical link under /de-de`, () => {
    assert.match(de, /<html lang="de-DE">/);
    assert.match(de, /<link rel="canonical" href="https:\/\/belline\.ai\/de-de(?:\/[a-z]+)?">/);
  });
}

test("the German landing page has the same FAQ, calculator and hero cards as the English one", () => {
  const en = read("landing.html");
  const de = read("landing.de.html");
  for (const [re, what] of [
    [/<details>/g, "FAQ questions"],
    [/<figure class="demo-card /g, "hero conversations"],
    [/<figure class="cal">/g, "hero calendars"],
    [/<li class="step">/g, "steps"],
    [/<ul class="kinds"[\s\S]*?<\/ul>/g, "kinds lists"],
    [/<input name="(?:missed|share|value)"/g, "calculator inputs"],
    [/class="(?:wa|chat|bell)-fab"/g, "floating buttons"],
  ] as [RegExp, string][]) {
    assert.equal(count(de, re), count(en, re), `a different number of ${what}`);
  }
});

test("each German legal page adds exactly one section, saying the English version governs", () => {
  for (const [english, german] of [["privacy.html", "privacy.de.html"], ["terms.html", "terms.de.html"]]) {
    const en = read(english);
    const de = read(german);
    assert.equal(count(de, /<h2>/g), count(en, /<h2>/g) + 1, `${german}: not exactly one extra section`);
    assert.match(de, /<h2>Sprachfassungen<\/h2>/, `${german}: no "Sprachfassungen" section`);
    assert.match(de, /<p class="legal-lang">[^<]*<a href="\/(?:privacy|terms)" hreflang="en" lang="en">englische Fassung<\/a>/, `${german}: no notice at the top linking to the English version`);
    assert.equal(count(de, /<li>/g), count(en, /<li>/g), `${german}: a different number of list items`);
  }
});

console.log(
  failed === 0 ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n` : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;
