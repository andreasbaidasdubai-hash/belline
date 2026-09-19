/**
 * Add a sending domain: everything AWS can do, then exactly what a person must.
 *
 *   npm run domain:setup -- --domain try-belline.com \
 *                           --mailbox andreas --name "Andreas Baidas" \
 *                           --topic arn:aws:sns:eu-west-1:123456789012:belline-ses-events \
 *                           --dmarc-reports dmarc@belline.ai
 *   npm run domain:setup -- --domain try-belline.com --dry-run
 *
 * Scaling past a couple of hundred messages a day means more domains, and each
 * one is an SES identity, a configuration set, an event destination, a custom
 * MAIL FROM, eight DNS records and two rows in our own store. Done by hand
 * that is an afternoon and at least one typo; the typo is the expensive part,
 * because a domain with a nearly-right SPF record verifies, sends, and lands
 * in spam for a month before anybody works out why.
 *
 * Three promises:
 *
 *  - **Nothing is invented.** Every DNS value printed is a constant AWS
 *    documents, something derived from the domain, or a token fetched from the
 *    SES API in this run. The DKIM tokens can only come from AWS, so if the
 *    identity does not exist yet, this creates it and then reads them back.
 *
 *  - **Safe to run twice.** Every call treats "already exists" as done. Run it
 *    again to re-print the records, or after adding a second mailbox.
 *
 *  - **It refuses belline.ai.** That domain carries customers' verification
 *    codes and booking confirmations. One complaint rate must never be able to
 *    ruin the other, so the refusal is in code rather than in a habit.
 */

import { sendingStore } from "../src/lib/sales/sending/store";
import {
  EVENT_TYPES,
  sesApi,
  type IdentityState,
  type SesApi,
} from "../src/lib/sales/sending/provisioning/sesApi";
import {
  asNamecheapTable,
  asZoneFile,
  dnsRecords,
  regionCanReceive,
  whatOnlyAPersonKnows,
  type DmarcPolicy,
} from "../src/lib/sales/sending/provisioning/records";

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function has(name: string): boolean {
  return args.includes(`--${name}`);
}
function bail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}
function all(name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === `--${name}` && args[i + 1]) out.push(args[i + 1]);
  });
  return out;
}

const domain = (flag("domain") ?? "").trim().toLowerCase().replace(/\.$/, "");
if (!domain) bail("Which domain? --domain try-belline.com");
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) bail(`"${domain}" does not look like a domain.`);

/**
 * The refusal. In code, at the top, before anything else can happen.
 *
 * belline.ai carries verification codes, password resets and booking
 * confirmations for paying customers. A cold list shares a sending reputation
 * with whatever else goes out under the same domain, and a customer's booking
 * confirmation landing in spam because a prospecting campaign got complained
 * about is not a risk worth any convenience.
 */
if (/(^|\.)belline\.ai$/.test(domain)) {
  bail(
    "belline.ai carries customers' transactional email — verification codes, password resets, booking\n" +
      "  confirmations. It must never send cold mail, and this command will not set it up to. Register a\n" +
      "  separate lookalike domain.",
  );
}

const mailboxes = all("mailbox").map((m) => (m.includes("@") ? m.toLowerCase() : `${m.toLowerCase()}@${domain}`));
const names = all("name");
const mailFromLabel = (flag("mail-from") ?? "mail").replace(/\.$/, "").replace(/\.*$/, "");
const dmarcReports = flag("dmarc-reports") ?? null;
const dmarcPolicy = (flag("dmarc") ?? "quarantine") as DmarcPolicy;
const topicArn = flag("topic") ?? process.env.OUTREACH_SES_EVENTS_TOPIC_ARN ?? null;
const bucket = flag("bucket") ?? process.env.OUTREACH_INBOUND_BUCKET ?? null;
const configurationSet = flag("config-set") ?? `belline-cold-${domain.replace(/[^a-z0-9]+/g, "-")}`;
const dailyCap = Number(flag("daily-cap") ?? 120);
const mailboxCap = Number(flag("mailbox-cap") ?? 30);
const dryRun = has("dry-run");
const receives = !has("no-inbound");

if (!["none", "quarantine", "reject"].includes(dmarcPolicy)) {
  bail(`--dmarc must be none, quarantine or reject (got "${dmarcPolicy}").`);
}
for (const address of mailboxes) {
  if (!address.endsWith(`@${domain}`)) bail(`${address} is not on ${domain}.`);
}
if (mailboxes.length > 0 && names.length !== mailboxes.length) {
  bail("Give one --name per --mailbox. A recipient sees the name, so it is not optional.");
}

console.log(`\n\x1b[1mSetting up ${domain}\x1b[0m\n`);

// ---------------------------------------------------------------------------
// What only a person can decide, said before anything is done
// ---------------------------------------------------------------------------

const human = whatOnlyAPersonKnows({ domain, dmarcReports, topicArn, bucket, mailboxes });
console.log("  These can only come from you:\n");
for (const item of human) {
  const shown = item.value ? `\x1b[32m${item.value}\x1b[0m` : "\x1b[33mnot given\x1b[0m";
  console.log(`    ${item.label.padEnd(58)} ${shown}`);
  if (!item.value) console.log(`      \x1b[90m${item.why}\x1b[0m`);
}
console.log("");

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------

const resolution = sesApi();
if (!resolution.ok && !dryRun) {
  bail(`${resolution.reason}\n\n  Or run with --dry-run to see the shape of it without touching AWS.`);
}

let identity: IdentityState | null = null;
let region = flag("region") ?? process.env.OUTREACH_SES_ADMIN_REGION ?? "eu-west-1";

if (resolution.ok && !dryRun) {
  const api: SesApi = resolution.api;
  region = api.region;

  const account = await api.getAccount();
  if (account.sandbox) {
    console.log(
      "  \x1b[33mThis SES account is still in the sandbox.\x1b[0m It can only send to verified addresses.\n" +
        "  Request production access in the SES console before any of this sends to a stranger.\n",
    );
  }

  const step = async (label: string, run: () => Promise<{ changed: boolean }>) => {
    try {
      const { changed } = await run();
      console.log(`  ${changed ? "\x1b[32m+\x1b[0m" : "\x1b[90m·\x1b[0m"} ${label}${changed ? "" : " (already)"}`);
    } catch (err) {
      console.log(`  \x1b[31m✗\x1b[0m ${label}`);
      bail((err as Error).message);
    }
  };

  const existing = await api.getIdentity(domain);
  if (!existing) {
    await step(`created the SES identity for ${domain}`, () => api.createIdentity(domain));
  } else {
    console.log(`  \x1b[90m·\x1b[0m the SES identity for ${domain} exists already`);
  }

  await step("turned Easy DKIM on", () => api.enableDkim(domain));
  await step(`set the MAIL FROM subdomain to ${mailFromLabel}.${domain}`, () =>
    api.setMailFrom(domain, `${mailFromLabel}.${domain}`),
  );
  await step(`created the configuration set ${configurationSet}`, () => api.createConfigurationSet(configurationSet));

  if (topicArn) {
    await step(`pointed ${EVENT_TYPES.join(", ").toLowerCase()} events at the SNS topic`, () =>
      api.createEventDestination({
        configurationSet,
        name: "belline-events",
        topicArn,
        eventTypes: EVENT_TYPES,
      }),
    );
  } else {
    console.log(
      "  \x1b[33m!\x1b[0m no --topic given, so no event destination was created.\n" +
        "      Without it, bounces and complaints never reach us and the watchdog has nothing to watch.",
    );
  }

  await step(`attached ${configurationSet} to the identity`, () =>
    api.attachConfigurationSet(domain, configurationSet),
  );

  identity = await api.getIdentity(domain);
  if (!identity || identity.dkimTokens.length === 0) {
    bail(
      "SES has not produced the DKIM tokens yet. They usually appear within a few seconds — run this\n" +
        "  command again and it will pick up where it left off.",
    );
  }
} else {
  console.log("  \x1b[33mDry run — AWS was not called, so there are no real DKIM tokens to print.\x1b[0m\n");
}

// ---------------------------------------------------------------------------
// Our own store
// ---------------------------------------------------------------------------

const store = sendingStore();
if (!dryRun) {
  const today = new Date().toISOString().slice(0, 10);
  // Remembered so `domain:verify` rebuilds the very records this run printed.
  // Without it, verifying with a different --dmarc-reports would report a
  // perfectly correct record as wrong.
  const choices = {
    region,
    mailFromLabel,
    dmarcReports,
    dmarcPolicy,
    configurationSet,
    receivesReplies: receives && regionCanReceive(region),
  };

  const domains = await store.listDomains();
  let row = domains.find((d) => d.domain === domain);
  if (!row) {
    row = await store.addDomain({
      domain,
      provider: "ses",
      purpose: "cold",
      status: "warming",
      dailyCap: Math.max(1, Math.min(dailyCap, 400)),
      dns: choices,
      notes: `configuration set ${configurationSet}`,
      pausedReason: null,
      pausedAt: null,
    });
    console.log(`\n  \x1b[32m+\x1b[0m registered ${domain} in the sending store, warming`);
  } else {
    await store.updateDomain(row.id, { dns: { ...row.dns, ...choices } });
    console.log(`\n  \x1b[90m·\x1b[0m ${domain} is already in the sending store`);
  }

  const existingBoxes = await store.listMailboxes();
  for (const [i, address] of mailboxes.entries()) {
    if (existingBoxes.some((m) => m.address === address)) {
      console.log(`  \x1b[90m·\x1b[0m ${address} is already a mailbox`);
      continue;
    }
    await store.addMailbox({
      domainId: row.id,
      address,
      displayName: names[i],
      replyTo: null,
      dailyCap: Math.max(1, Math.min(mailboxCap, 50)),
      // Warm-up starts today. It is a pure function of this date, so a
      // mailbox added now sends five a day this week whatever anybody sets.
      warmupStartedOn: today,
      status: "warming",
      pausedReason: null,
      pausedAt: null,
    });
    console.log(`  \x1b[32m+\x1b[0m ${address} — "${names[i]}", warm-up started ${today}, five a day this week`);
  }
  if (store.kind === "memory") {
    console.log(
      "\n  \x1b[33m!\x1b[0m DATABASE_URL is not set, so those rows went into memory and are gone when this\n" +
        "      process exits. Set it and run again to keep them.",
    );
  }
}

// ---------------------------------------------------------------------------
// The DNS records
// ---------------------------------------------------------------------------

if (receives && !regionCanReceive(region)) {
  console.log(
    `\n  \x1b[33m!\x1b[0m SES cannot receive mail in ${region}, so no inbound MX is printed and replies to this\n` +
      `      domain will go nowhere. Use a region that can receive, or pass --no-inbound knowingly.`,
  );
}

const records = dnsRecords({
  domain,
  dkimTokens: identity?.dkimTokens ?? [],
  mailFromLabel,
  region,
  dmarcReports,
  dmarcPolicy,
  receivesReplies: receives && regionCanReceive(region),
});

console.log(`\n\x1b[1mDNS records to add at the registrar\x1b[0m\n`);
if (!identity) {
  console.log(
    "  \x1b[33mThe three DKIM CNAMEs are missing from this list.\x1b[0m They can only come from AWS, and this\n" +
      "  was a dry run, so they are not printed rather than made up.\n",
  );
}
console.log(asNamecheapTable(records).split("\n").map((l) => `  ${l}`).join("\n"));

console.log("\n  What each one is for:\n");
for (const record of records) {
  console.log(`    ${record.kind.padEnd(6)} ${record.host.padEnd(28)} ${record.purpose}`);
}

if (has("zone")) {
  console.log(`\n\x1b[1mThe same as a zone file\x1b[0m\n`);
  console.log(asZoneFile(records).split("\n").map((l) => `  ${l}`).join("\n"));
}

console.log(
  `\n\x1b[1mAt Namecheap\x1b[0m\n\n` +
    `  Domain List → ${domain} → Manage → Advanced DNS.\n` +
    `  Delete the parking CNAME on @ and the "URL Redirect" record if they are there; both quietly win\n` +
    `  against what you add. Under Mail Settings choose Custom MX, not Email Forwarding — Namecheap's\n` +
    `  forwarding MX records will otherwise sit in front of the SES ones and replies will never arrive.\n` +
    `  Then add the rows above exactly as printed. Host is the Host column, not the full name.\n`,
);

console.log(
  `\x1b[1mThen\x1b[0m\n\n` +
    `  npm run domain:verify -- --domain ${domain}\n\n` +
    `  which checks each record from outside and asks SES what it has noticed so far.\n`,
);

process.exit(0);
