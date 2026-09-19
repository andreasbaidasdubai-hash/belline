/**
 * Has the DNS propagated, and does SES agree.
 *
 *   npm run domain:verify -- --domain try-belline.com
 *   npm run domain:verify -- --domain try-belline.com --resolver 1.1.1.1
 *
 * Checked from outside, against a public resolver rather than whatever this
 * machine happens to use — a registrar's own nameserver answers correctly for
 * a record that has not propagated anywhere else, which is how a domain gets
 * marked ready an hour too early.
 *
 * Two separate answers, printed separately on purpose. DNS and SES fail
 * independently: a record can be live while SES still says pending, because
 * SES re-checks on a timer of its own; and SES can say DKIM succeeded while
 * the MAIL FROM MX was never added. One combined verdict would hide whichever
 * of the two was wrong.
 */

import { Resolver as NodeResolver } from "node:dns/promises";
import { sendingStore } from "../src/lib/sales/sending/store";
import { sesApi, type IdentityState } from "../src/lib/sales/sending/provisioning/sesApi";
import { dnsRecords, regionCanReceive, type DmarcPolicy } from "../src/lib/sales/sending/provisioning/records";
import { checkAll, describeIdentity, type Resolver } from "../src/lib/sales/sending/provisioning/verify";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const bail = (message: string): never => {
  console.error(`\n  ${message}\n`);
  process.exit(1);
};

const domain = (flag("domain") ?? "").trim().toLowerCase().replace(/\.$/, "");
if (!domain) bail("Which domain? --domain try-belline.com");

/**
 * The choices `domain:setup` made, read back from our own store.
 *
 * Read first, and only overridden by a flag. Regenerating the DMARC line with
 * a different report address would report a perfectly correct record as wrong,
 * which sends somebody re-typing a record that was already right.
 */
const store = sendingStore();
const row = (await store.listDomains()).find((d) => d.domain === domain);
const remembered = row?.dns ?? {};

const mailFromLabel = flag("mail-from") ?? remembered.mailFromLabel ?? "mail";
const dmarcReports = flag("dmarc-reports") ?? remembered.dmarcReports ?? null;
const dmarcPolicy = (flag("dmarc") ?? remembered.dmarcPolicy ?? "quarantine") as DmarcPolicy;

/** Cloudflare by default: a third party, which is the point of checking. */
const servers = (flag("resolver") ?? "1.1.1.1,8.8.8.8").split(",").map((s) => s.trim()).filter(Boolean);
const node = new NodeResolver({ timeout: 5_000, tries: 2 });
node.setServers(servers);
const resolver: Resolver = {
  resolveCname: (name) => node.resolveCname(name),
  resolveTxt: (name) => node.resolveTxt(name),
  resolveMx: (name) => node.resolveMx(name),
};

console.log(`\n\x1b[1m${domain}\x1b[0m — checked through ${servers.join(", ")}\n`);

// ---------------------------------------------------------------------------
// What SES has, which is where the DKIM tokens come from
// ---------------------------------------------------------------------------

const resolution = sesApi();
let identity: IdentityState | null = null;
let region = flag("region") ?? remembered.region ?? process.env.OUTREACH_SES_ADMIN_REGION ?? "eu-west-1";

if (resolution.ok) {
  region = resolution.api.region;
  identity = await resolution.api.getIdentity(domain);
} else {
  console.log(
    `  \x1b[33mSES was not asked: ${resolution.reason}\x1b[0m\n` +
      `  Only the records that do not depend on AWS can be checked.\n`,
  );
}

const records = dnsRecords({
  domain,
  dkimTokens: identity?.dkimTokens ?? [],
  mailFromLabel,
  region,
  dmarcReports,
  dmarcPolicy,
  receivesReplies: (remembered.receivesReplies ?? true) && regionCanReceive(region),
});

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

console.log("\x1b[1mDNS\x1b[0m\n");
const report = await checkAll(records, resolver);
const mark = { ok: "\x1b[32m✓\x1b[0m", missing: "\x1b[33m·\x1b[0m", wrong: "\x1b[31m✗\x1b[0m", unchecked: "\x1b[90m?\x1b[0m" };
for (const check of report.checks) {
  console.log(`  ${mark[check.verdict]} ${check.record.kind.padEnd(6)} ${check.record.host.padEnd(30)} ${check.note}`);
}
if (identity === null && resolution.ok) {
  console.log("  \x1b[33m·\x1b[0m CNAME  the three DKIM records     SES has no identity for this domain yet");
}
if (!identity?.dkimTokens.length) {
  console.log(
    "\n  The DKIM CNAMEs are not in that list because only AWS knows their names. Run\n" +
      `  npm run domain:setup -- --domain ${domain} first.`,
  );
}

// ---------------------------------------------------------------------------
// SES
// ---------------------------------------------------------------------------

console.log("\n\x1b[1mSES\x1b[0m\n");
for (const verdict of describeIdentity(identity)) {
  console.log(`  ${verdict.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[33m·\x1b[0m"} ${verdict.line}`);
}

// ---------------------------------------------------------------------------
// Our own store
// ---------------------------------------------------------------------------

const boxes = row ? (await store.listMailboxes()).filter((m) => m.domainId === row.id) : [];

console.log("\n\x1b[1mOur store\x1b[0m\n");
if (!row) {
  console.log(`  \x1b[33m·\x1b[0m ${domain} is not registered here. Run domain:setup.`);
} else {
  console.log(`  \x1b[32m✓\x1b[0m ${domain} — ${row.status}, cap ${row.dailyCap} a day`);
  if (boxes.length === 0) {
    console.log("  \x1b[33m·\x1b[0m no mailboxes on it, so nothing will be planned for it");
  }
  for (const box of boxes) {
    console.log(
      `  \x1b[32m✓\x1b[0m ${box.address} — ${box.status}` +
        (box.warmupStartedOn ? `, warming since ${box.warmupStartedOn}` : ", \x1b[33mwarm-up not started\x1b[0m"),
    );
  }
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

const sesReady = identity?.verifiedForSending === true && identity.dkimStatus === "SUCCESS";
console.log("");
if (report.ok && sesReady) {
  console.log("  \x1b[32mReady.\x1b[0m DNS is right and SES has verified it. Start the mailboxes' warm-up if you have not.\n");
} else if (report.outstanding.length > 0) {
  console.log(`  \x1b[33m${report.outstanding.length} record${report.outstanding.length === 1 ? "" : "s"} still to fix:\x1b[0m\n`);
  for (const check of report.outstanding) {
    console.log(`    ${check.record.kind} ${check.record.host} → ${check.record.value}`);
    console.log(`      ${check.note}`);
  }
  console.log("\n  DNS takes minutes to hours to propagate. Run this again rather than changing anything twice.\n");
} else {
  console.log("  DNS looks right; SES has not caught up yet. It re-checks on its own — run this again later.\n");
}

process.exit(report.ok && sesReady ? 0 : 1);
