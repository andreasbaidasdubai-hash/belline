/**
 * The console may not claim a capability whose code path does not exist.
 *
 * The sales console said "Ready to send", counted "Meetings — booked", offered
 * activity filters for `sent`, `replied` and `meeting_booked`, told staff to
 * start a worker that would carry the pipeline, and reported Swiss consent as
 * "gated". None of it was true. There is no sender, nothing inserts into
 * `sales.meeting`, nothing writes those activity rows, the worker registers
 * only `noop` and `always_fails`, and no code under `src/lib/sales` reads
 * `config.compliance` at all.
 *
 * A screen that overstates the machine is worse than one that understates it:
 * the drafts sat in a queue labelled as an outbox, and the obvious reading was
 * that mail was going out.
 *
 * So this holds no list of banned phrases. It asks, for each claim, the
 * question the claim depends on — is there a sender? does anything write a
 * meeting? — and fails when the console makes the claim while the answer is
 * no. When somebody builds the sender, these tests stop failing on their own,
 * which is the only kind of honesty check that survives.
 *
 *   npm run check:sales-honesty
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

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

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, match));
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

const read = (f: string) => fs.readFileSync(f, "utf8");
/** Comments explain these defects and quote the very words being banned. */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const CONSOLE_DIR = path.join(process.cwd(), "src", "app", "(internal)");
const SALES_LIB = path.join(process.cwd(), "src", "lib", "sales");
const SALES_API = path.join(process.cwd(), "src", "app", "api", "sales");

const consoleFiles = walk(CONSOLE_DIR, /\.tsx?$/);
/** Everything the console renders, comments stripped. */
const consoleCode = consoleFiles.map((f) => code(read(f))).join("\n");
const salesCode = walk(SALES_LIB, /\.ts$/).map(read).join("\n");
const allSrc = walk(path.join(process.cwd(), "src"), /\.tsx?$/).map(read).join("\n");

// --- the mechanisms, asked rather than assumed -----------------------------

const handlers = read(path.join(SALES_LIB, "queue", "handlers", "index.ts"));
/** Handler keys registered against the worker. */
const registered = [...handlers.matchAll(/^\s{2}([a-z_]+):\s*async/gm)].map((m) => m[1]);
const realHandlers = registered.filter((h) => h !== "noop" && h !== "always_fails");

/** Does anything read a message back out of `approved` to act on it? */
const readsApproved = /status\s*=\s*'approved'|status\s*===?\s*["']approved["']/.test(
  salesCode.replace(/set status = 'approved'/g, ""),
);
const senderExists = realHandlers.length > 0 || readsApproved;

const writesMeeting = /insert\s+into\s+sales\.meeting/i.test(allSrc);
const readsCompliance = /\bconfig\.compliance\b/.test(salesCode);

/**
 * Activity types something actually writes.
 *
 * Derived rather than listed, and fussy about where it looks. The CRM stage
 * names are the same words as the activity types — `where l.stage in
 * ('replied', ...)` reads leads and writes nothing — so a plain grep for
 * 'replied' would conclude that replies are recorded. Only two forms count:
 * the `type:` a log() call is handed, both arms of a ternary included, and the
 * literals inside an `insert into sales.activity`. Everything is then
 * intersected with the declared union, which drops the `type: "string"` of a
 * JSON schema.
 */
const ACTIVITY_TYPES = (() => {
  const src = read(path.join(SALES_LIB, "db", "repo", "activity.ts"));
  const block = src.match(/export type ActivityType =([\s\S]*?);/);
  assert.ok(block, "could not find the ActivityType union");
  return new Set([...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
})();

/** The staff console's own writers (drafts edited, approved and marked sent by hand) live here. */
const STAFF_LIB = path.join(process.cwd(), "src", "lib", "staff");

const writerCode = [...walk(SALES_LIB, /\.ts$/), ...walk(SALES_API, /\.ts$/), ...walk(STAFF_LIB, /\.ts$/)]
  .map(read)
  .join("\n");

const writtenTypes = new Set<string>();
for (const line of writerCode.split("\n")) {
  if (!/\btype:/.test(line)) continue;
  for (const q of line.matchAll(/["'](\w+)["']/g)) {
    if (ACTIVITY_TYPES.has(q[1])) writtenTypes.add(q[1]);
  }
}
for (const stmt of writerCode.matchAll(/insert\s+into\s+sales\.activity[\s\S]{0,600}?`/gi)) {
  for (const lit of stmt[0].matchAll(/'(\w+)'/g)) {
    if (ACTIVITY_TYPES.has(lit[1])) writtenTypes.add(lit[1]);
  }
}

/** The filters the activity page offers. */
const activityPage = read(path.join(CONSOLE_DIR, "sales", "settings", "activity", "page.tsx"));
const offeredTypes = (() => {
  const block = activityPage.match(/const TYPES = \[([\s\S]*?)\];/);
  assert.ok(block, "could not find the TYPES array on the activity page");
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
})();

console.log("\n\x1b[1mWhat the console claims, against what exists\x1b[0m\n");

test("the scan is looking at a real console", () => {
  // Every test below passes trivially if the walk found nothing.
  assert.ok(consoleFiles.length >= 10, `only ${consoleFiles.length} files under (internal)`);
  assert.ok(salesCode.length > 10_000, "src/lib/sales did not load");
  assert.ok(ACTIVITY_TYPES.size > 10, "the ActivityType union did not parse");
  assert.ok(writtenTypes.size > 0, "no activity writer found at all — the scan is broken");
});

test("no send language while there is no sender", () => {
  if (senderExists) return; // built — the claim is allowed again
  const banned = [
    /ready to send/i,
    /\bwill be sent\b/i,
    /\bgoes out\b/i,
    /\boutbox\b/i,
    /\bsending now\b/i,
  ];
  const offenders: string[] = [];
  for (const f of consoleFiles) {
    const text = code(read(f));
    for (const p of banned) {
      const hit = text.match(p);
      if (hit) offenders.push(`${path.relative(process.cwd(), f)}: "${hit[0]}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `there is no sender (handlers: ${registered.join(", ") || "none"}), but: ${offenders.join("; ")}`,
  );
});

test("the page says plainly that nothing can be sent", () => {
  if (senderExists) return;
  // Not merely the absence of a lie — the draft has to say what it is. The
  // approval queue became the "Email draft" section of a lead's page.
  const draft = read(path.join(CONSOLE_DIR, "sales", "leads", "[id]", "EmailDraft.tsx"));
  assert.match(
    code(draft),
    /Nothing here can be sent/,
    "the email draft must state that there is no sender",
  );
});

test("no Meetings figure while nothing writes a meeting", () => {
  if (writesMeeting) return;
  assert.ok(
    !/label="Meetings"/.test(consoleCode),
    "a Meetings stat is rendered, but nothing inserts into sales.meeting — it can only ever be 0",
  );
});

test("every activity filter offered is one something writes", () => {
  const impossible = offeredTypes.filter((t) => !writtenTypes.has(t));
  assert.deepEqual(
    impossible,
    [],
    `filters that can never match: ${impossible.join(", ")}. Written: ${[...writtenTypes].sort().join(", ")}`,
  );
});

test("no enforcement claim while nothing reads the compliance config", () => {
  if (readsCompliance) return;
  // Affirmative claims only. "recorded, not enforced" is the honest form and
  // has to keep passing, or the check argues against its own fix.
  const banned = [/\bis gated\b/i, /\bwe enforce\b/i, /\bis enforced\b/i, /\benforces\b/i];
  const offenders: string[] = [];
  for (const f of consoleFiles) {
    const text = code(read(f));
    for (const p of banned) {
      const hit = text.match(p);
      if (hit) offenders.push(`${path.relative(process.cwd(), f)}: "${hit[0]}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `nothing reads config.compliance, but the console claims: ${offenders.join("; ")}`,
  );
});

test("no unsubscribe link is written while nothing can honour one", () => {
  // /u/ has never existed. A stored body carrying a link to it is a dead link
  // in a draft a person can copy out of the approval queue by hand, and the
  // literal "{token}" that used to be written there is the worst version of
  // it: it looks like a link and cannot even be clicked.
  if (fs.existsSync(path.join(process.cwd(), "src", "app", "u"))) return;
  // Not `code()` here: its comment stripper treats the // in https:// as
  // the start of a comment and eats the rest of the line — which is the
  // exact shape of the thing being looked for, so it hid a real link. Drop
  // whole comment lines instead, and compare as plain text.
  const source =
    read(path.join(SALES_LIB, "outreach", "run.ts")) +
    read(path.join(SALES_LIB, "outreach", "templates.ts"));
  const outreach = source
    .split("\n")
    .filter((l) => {
      const s = l.trim();
      return !s.startsWith("//") && !s.startsWith("*") && !s.startsWith("/*");
    })
    .join("\n");
  assert.ok(
    !outreach.includes("{token}"),
    "a {token} placeholder is still written into stored bodies",
  );
  assert.ok(
    !outreach.includes("/u/"),
    "an unsubscribe URL is still being built, but /u/ does not exist",
  );
});

test("the worker is not described as running the pipeline", () => {
  if (realHandlers.length > 0) return;
  const offenders: string[] = [];
  for (const f of consoleFiles) {
    const text = code(read(f));
    const hit = text.match(/Every pipeline stage runs here|the worker runs the pipeline/i);
    if (hit) offenders.push(`${path.relative(process.cwd(), f)}: "${hit[0]}"`);
  }
  assert.deepEqual(offenders, [], `only noop and always_fails are registered: ${offenders.join("; ")}`);
});

test("autonomy mode is not shown as though it changed behaviour", () => {
  // Stored, typed, seeded and displayed — and branched on nowhere.
  const branches = /autonomy_mode\s*===?\s*["'](review|semi|autonomous)["']/.test(salesCode);
  if (branches) return;
  assert.ok(
    !/autonomy mode|mode \$\{/.test(consoleCode),
    "the console presents an autonomy mode, but nothing reads autonomy_mode",
  );
});

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exitCode = 1;
