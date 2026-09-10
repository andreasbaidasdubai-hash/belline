import fs from "node:fs";
import path from "node:path";

// The corruption was: UTF-8 bytes decoded as Windows-1252, then re-saved as
// UTF-8. Reversing it needs the cp1252 high range, which is NOT Latin-1 —
// that is why a plain latin1 round trip only fixed some characters.
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];
const toByte = new Map();
for (let b = 0; b < 0x80; b++) toByte.set(b, b);
for (let b = 0xa0; b <= 0xff; b++) toByte.set(b, b);
CP1252_HIGH.forEach((cp, i) => toByte.set(cp, 0x80 + i));

function unmangle(text) {
  const bytes = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { bytes.push(cp); continue; }
    const b = toByte.get(cp);
    if (b === undefined) return null; // Not a mangled string; leave it alone.
    bytes.push(b);
  }
  const decoded = Buffer.from(bytes).toString("utf8");
  return decoded.includes("\uFFFD") ? null : decoded;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

let changed = 0;
for (const file of walk("src")) {
  const text = fs.readFileSync(file, "utf8");
  if (!/[\u00c2\u00c3\u00e2]/.test(text)) continue;
  const fixed = unmangle(text);
  if (fixed && fixed !== text) {
    fs.writeFileSync(file, fixed, "utf8");
    console.log("repaired " + file);
    changed++;
  }
}
console.log(changed === 0 ? "nothing left to repair" : changed + " file(s) repaired");
