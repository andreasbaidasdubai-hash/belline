/**
 * Repair UTF-8 that has been round-tripped through Windows-1252.
 *
 * Windows PowerShell 5.1's Get-Content reads a BOM-less UTF-8 file using the
 * system ANSI codepage, so every multi-byte character comes back as two or
 * three Latin-1 characters; writing it out again bakes that in. Decoding each
 * mangled run back to bytes and re-reading it as UTF-8 reverses it exactly.
 *
 *   node scripts/fix-encoding.mjs
 */

import fs from "node:fs";
import path from "node:path";

const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x2022, 0x2013,
];
// Built explicitly rather than from the table above, which is easy to
// mis-index: byte 0x80 + i maps to CP1252_MAP[i].
const CP1252_MAP = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];
void CP1252_HIGH;

const toByte = new Map();
for (let b = 0x80; b <= 0xff; b++) toByte.set(b, b);
CP1252_MAP.forEach((cp, i) => toByte.set(cp, 0x80 + i));

const RUN =
  /[Â-ô][-ÿŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™]{1,3}/g;

function repair(text) {
  return text.replace(RUN, (run) => {
    const bytes = [];
    for (const ch of run) {
      const b = toByte.get(ch.codePointAt(0));
      if (b === undefined) return run;
      bytes.push(b);
    }
    const decoded = Buffer.from(bytes).toString("utf8");
    if (decoded.includes("�") || [...decoded].length >= [...run].length) return run;
    return decoded;
  });
}

// Anchored at a path boundary OR the start of the string — a leading
// `node_modules\...` has no separator in front of it, and an exclude that
// only matches `[\\/]node_modules[\\/]` walks straight into it.
const EXCLUDE = /(^|[\\/])(node_modules|\.next|site|data|\.git)([\\/]|$)/;
const EXT = /\.(ts|tsx|html|md|mjs|css|json)$/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (EXCLUDE.test(p + path.sep)) continue;
    if (entry.isDirectory()) walk(p, out);
    else if (EXT.test(entry.name)) out.push(p);
  }
  return out;
}

let changed = 0;
for (const file of walk(".")) {
  if (file.endsWith("fix-encoding.mjs")) continue;
  const before = fs.readFileSync(file, "utf8");
  const after = repair(before);
  if (after !== before) {
    fs.writeFileSync(file, after, "utf8");
    console.log(`  repaired ${file}`);
    changed++;
  }
}
console.log(changed === 0 ? "  nothing to repair" : `  ${changed} file(s) repaired`);
