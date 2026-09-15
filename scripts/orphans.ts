/**
 * List the accounts a failed signup left behind. Read-only.
 *
 * Before signup was atomic, a rejected password still wrote a tenant, a
 * business and a venue with no owner. This prints them so a person can decide
 * what to do. It never deletes, never writes, and does not go through the
 * store (which would seed an empty data directory): it only reads the JSON
 * files.
 *
 *   npm run orphans                       # reads ./data
 *   DATA_DIR=/mnt/book npm run orphans    # reads a mounted copy
 *   ... --keep tnt_abc,tnt_def            # tenants that are ours on purpose
 */

import fs from "node:fs";
import path from "node:path";
import { findOrphans } from "../src/lib/onboarding/orphans";
import { BELLINE_TENANT_ID, DEFAULT_TENANT_ID } from "../src/lib/tenancy";

if (!process.argv.includes("--dry-run")) {
  console.error("Only --dry-run exists. Deleting orphans is a decision for a person, made by hand.");
  process.exit(2);
}

const dir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), "data");

function read<T>(key: string): T[] {
  const file = path.join(dir, `${key}.json`);
  if (!fs.existsSync(file)) {
    console.error(`No ${key}.json in ${dir}.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as T[];
}

const keepArg = process.argv.indexOf("--keep");
const keep = [
  DEFAULT_TENANT_ID,
  BELLINE_TENANT_ID,
  ...(keepArg > -1 ? String(process.argv[keepArg + 1] ?? "").split(",").filter(Boolean) : []),
];

const report = findOrphans(
  {
    tenants: read("tenants"),
    businesses: read("businesses"),
    locations: read("locations"),
    users: read("users"),
  },
  keep,
);

console.log(`Reading ${dir} (dry run, nothing is changed)\n`);
console.log(`Tenants with no user: ${report.tenants.length}`);
for (const t of report.tenants) console.log(`  ${t.id}  ${t.createdAt}  ${t.name}`);
console.log(`Businesses in those tenants: ${report.businesses.length}`);
for (const b of report.businesses) console.log(`  ${b.id}  tenant ${b.tenantId}  ${b.name}`);
console.log(`Venues in those tenants: ${report.locations.length}`);
for (const l of report.locations) console.log(`  ${l.id}  tenant ${l.tenantId}  ${l.name}`);
