/**
 * Remove every customer venue, keeping Belline's own and the demo lines.
 *
 * A clean slate for testing the new backend, asked for on 2026-09-16. It is
 * deliberately not a "delete everything": Belline's own venue is what the
 * "Speak to Belline" button on the website rings, and the three demo lines are
 * what the demo numbers ring, so wiping those would take the marketing site
 * down in order to make the dashboard tidy. They are also pointless to delete:
 * `addMissingVenues()` in seed.ts puts every fixture back on the next boot.
 *
 * Dry by default. Nothing is written without --yes, and the dry run prints the
 * exact list so a person can read it before agreeing to it.
 *
 *   node --import tsx scripts/wipe-customers.ts            # list only
 *   node --import tsx scripts/wipe-customers.ts --yes      # actually delete
 *
 * Runs inside the container it is clearing, because each environment keeps its
 * own store on its own volume:
 *
 *   railway ssh --service belline --environment staging -- \
 *     node --import tsx scripts/wipe-customers.ts
 *
 * Sign-ins are left alone: store.ts has no remove for a user, and inventing one
 * for a one-off wipe is the wrong place for it. What remains is an email and a
 * password hash pointing at a tenant that no longer exists — inert, and cleaned
 * up properly by the account-deletion work (P1-8), which this venue is meant to
 * be the first real test of.
 */

import { listLocations, listTenants, removeBusiness, removeLocation, removeTenant } from "../src/lib/store";
import { BELLINE_TENANT_ID, DEFAULT_TENANT_ID } from "../src/lib/tenancy";
import { BELLINE_LOCATION_ID } from "../src/lib/seed-belline";

const commit = process.argv.includes("--yes");

/** The venues seed.ts plants on every boot: ours, and the three demo lines. */
const KEEP_LOCATIONS = new Set([BELLINE_LOCATION_ID, "loc_azure", "loc_lumiere", "loc_meridian"]);
const KEEP_TENANTS = new Set([BELLINE_TENANT_ID, DEFAULT_TENANT_ID]);

const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

/**
 * Personalised demos built for a sales prospect (prospect.ts). They sit under
 * Belline's own tenant, they expire on their own, and a draft email may point
 * a named company at one — so they are not "old customer venues" and are left
 * alone unless somebody asks for them by name.
 */
const isProspect = (id: string) => id.startsWith("prospect_");
const withProspects = process.argv.includes("--prospects");

const locations = listLocations({ includeInternal: true, includeArchived: true });
const kept = locations.filter((l) => KEEP_LOCATIONS.has(l.id));
const prospects = locations.filter((l) => !KEEP_LOCATIONS.has(l.id) && isProspect(l.id));
const doomed = locations.filter(
  (l) => !KEEP_LOCATIONS.has(l.id) && (withProspects || !isProspect(l.id)),
);

console.log(`\n\x1b[1mVenues\x1b[0m — ${locations.length} in this store\n`);
for (const l of kept) console.log(`  ${green("keep  ")}  ${l.id.padEnd(22)} ${l.name}`);
for (const l of doomed) console.log(`  ${red("delete")}  ${l.id.padEnd(22)} ${l.name}  (tenant ${l.tenantId})`);
if (doomed.length === 0) console.log(`  ${green("nothing to delete — this store is already a clean slate")}`);
if (!withProspects && prospects.length) {
  console.log(`\n\x1b[1mSales demos\x1b[0m — ${prospects.length} left alone (pass --prospects to include them)\n`);
  for (const l of prospects) console.log(`  ${green("keep  ")}  ${l.id.padEnd(22)} ${l.name}`);
}

// A tenant goes only when nothing kept still belongs to it.
const survivingTenants = new Set(kept.map((l) => l.tenantId));
const tenantsToRemove = [...new Set(doomed.map((l) => l.tenantId))].filter(
  (t) => !KEEP_TENANTS.has(t) && !survivingTenants.has(t),
);

if (tenantsToRemove.length) {
  const names = new Map(listTenants().map((t) => [t.id, t.name]));
  console.log(`\n\x1b[1mTenants\x1b[0m — ${tenantsToRemove.length} left with no venue\n`);
  for (const t of tenantsToRemove) console.log(`  ${red("delete")}  ${t.padEnd(22)} ${names.get(t) ?? "(unnamed)"}`);
}

if (!commit) {
  console.log(`\n\x1b[33mDry run — nothing was changed.\x1b[0m Re-run with --yes to delete the above.\n`);
  process.exit(0);
}

for (const l of doomed) {
  removeLocation(l.id);
  if (l.businessId) removeBusiness(l.businessId);
}
for (const t of tenantsToRemove) removeTenant(t);

console.log(
  `\n${green("Done.")} Removed ${doomed.length} venue(s) and ${tenantsToRemove.length} tenant(s).` +
    `\nBelline's own venue and the demo lines are untouched, and seed.ts will restore any that were missing on the next boot.\n`,
);
