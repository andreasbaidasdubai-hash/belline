import fs from "node:fs";
import path from "node:path";
import { close, isConfigured, query } from "../src/lib/sales/db/client";
import { demoRoot } from "../src/lib/sales/demos/render";

/**
 * `npm run demos:backfill`
 *
 * Push locally-rendered demo clips into the database.
 *
 * One-off for clips generated before the audio moved into Postgres, and
 * harmless to re-run: every insert is keyed on the content hash, so an
 * existing clip is skipped rather than rewritten.
 *
 * The role and text come from the demo records that reference each clip —
 * a filename is a hash and says nothing about what was said.
 */

if (!isConfigured()) {
  console.error("\n  DATABASE_URL is not set.\n");
  process.exit(1);
}

const root = demoRoot();
if (!fs.existsSync(root)) {
  console.error(`\n  No local clips at ${root}\n`);
  process.exit(0);
}

// What each clip actually is, from the demos that reference it.
const demos = await query<{ script: { clips?: { id: string; role: string; text: string }[] } }>(
  `select script from sales.demo where script ? 'clips'`,
);
const known = new Map<string, { role: string; text: string }>();
for (const demo of demos) {
  for (const clip of demo.script.clips ?? []) known.set(clip.id, { role: clip.role, text: clip.text });
}

const files = fs.readdirSync(root).filter((f) => f.endsWith(".mp3"));
let inserted = 0;
let skipped = 0;
let orphaned = 0;
let bytes = 0;

for (const file of files) {
  const id = path.basename(file, ".mp3");
  if (!/^[0-9a-f]{16}$/.test(id)) continue;

  const meta = known.get(id);
  if (!meta) {
    // A clip no longer referenced by any demo — superseded by a rebuild.
    // Not worth carrying into the database.
    orphaned++;
    continue;
  }

  const audio = fs.readFileSync(path.join(root, file));
  const result = await query<{ id: string }>(
    `insert into sales.demo_clip (id, role, text, bytes)
     values ($1, $2, $3, $4)
     on conflict (id) do nothing
     returning id`,
    [id, meta.role, meta.text, audio],
  );

  if (result.length > 0) {
    inserted++;
    bytes += audio.length;
  } else {
    skipped++;
  }
}

const total = await query<{ n: number; kb: number }>(
  `select count(*)::int as n, (coalesce(sum(size_bytes),0) / 1024)::int as kb from sales.demo_clip`,
);

console.log(`
  uploaded    ${inserted}  (${Math.round(bytes / 1024)} KB)
  already in  ${skipped}
  orphaned    ${orphaned}  (not referenced by any demo — left on disk)

  database now holds ${total[0].n} clips, ${total[0].kb} KB
`);

await close();
