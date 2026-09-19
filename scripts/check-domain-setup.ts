/**
 * Adding a sending domain (src/lib/sales/sending/provisioning, scripts/domain-*).
 *
 * Getting a sending domain wrong is not a crash. It is a domain that verifies,
 * sends, and lands in spam for a month before anybody works out why — so what
 * is pinned here is every way the setup could be quietly wrong:
 *
 *  - a **DKIM token invented** rather than fetched, which is three CNAMEs that
 *    look right and sign nothing;
 *  - **SPF or DMARC nearly right**, which passes a glance and fails alignment;
 *  - **no MAIL FROM subdomain**, so SPF aligns to amazonses.com and DMARC
 *    passes on DKIM alone;
 *  - **no inbound MX**, so every reply this quarter goes nowhere;
 *  - a region that **cannot receive mail**, which is the same thing with a
 *    plausible hostname in front of it;
 *  - **belline.ai** being set up to send cold mail;
 *  - a command that **cannot be run twice**, which is the same as a command
 *    nobody dares run at all.
 *
 * No network, no AWS, no credentials. The SES client is a stub that records
 * what it was asked to do, and the last section proves that the real one
 * cannot be reached without somebody having explicitly supplied keys.
 *
 *   npm run check:domain-setup
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-domain-"));
delete process.env.DATABASE_URL;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("OUTREACH_") || key.startsWith("AWS_")) delete process.env[key];
}
process.env.FLAG_STUBS = "on";

const NETWORK_OFF = () => {
  throw new Error("network is off in check:domain-setup");
};
globalThis.fetch = NETWORK_OFF as unknown as typeof fetch;

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.log(err.stack.split("\n").slice(1, 4).map((l) => `      ${l.trim()}`).join("\n"));
    }
    failed++;
  }
}

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m\n`);
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

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const recordsMod = await import("../src/lib/sales/sending/provisioning/records");
const verifyMod = await import("../src/lib/sales/sending/provisioning/verify");
const sesApiMod = await import("../src/lib/sales/sending/provisioning/sesApi");
type DnsRecord = import("../src/lib/sales/sending/provisioning/records").DnsRecord;
type Resolver = import("../src/lib/sales/sending/provisioning/verify").Resolver;

const TOKENS = ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccccccccccccc"];

const RECORDS = recordsMod.dnsRecords({
  domain: "try-belline.com",
  dkimTokens: TOKENS,
  mailFromLabel: "mail",
  region: "eu-west-1",
  dmarcReports: "dmarc@belline.ai",
});

const find = (kind: DnsRecord["kind"], host: string) =>
  RECORDS.find((r) => r.kind === kind && r.host === host);

// ---------------------------------------------------------------------------
section("Every record, and where its value came from");

await test("the three DKIM CNAMEs are the tokens AWS gave, not invented ones", () => {
  const cnames = RECORDS.filter((r) => r.kind === "CNAME");
  assert.equal(cnames.length, 3);
  for (const [i, token] of TOKENS.entries()) {
    assert.equal(cnames[i].fqdn, `${token}._domainkey.try-belline.com`);
    assert.equal(cnames[i].value, `${token}.dkim.amazonses.com`);
  }
});

await test("with no tokens, no DKIM records are printed at all", () => {
  // The failure this prevents: three plausible-looking strings that sign
  // nothing, typed into a registrar and believed for a month.
  const dry = recordsMod.dnsRecords({ domain: "try-belline.com", dkimTokens: [], mailFromLabel: "mail", region: "eu-west-1" });
  assert.equal(dry.filter((r) => r.kind === "CNAME").length, 0);
});

await test("SPF at the root names SES and hard-fails everything else", () => {
  const spf = find("TXT", "@");
  assert.equal(spf?.value, "v=spf1 include:amazonses.com -all");
});

await test("DMARC carries a policy, the report address and relaxed alignment", () => {
  const dmarc = find("TXT", "_dmarc");
  assert.match(dmarc!.value, /^v=DMARC1; p=quarantine; rua=mailto:dmarc@belline\.ai;/);
  // Strict alignment would fail SPF on every message, because the MAIL FROM is
  // a subdomain of the From domain.
  assert.match(dmarc!.value, /adkim=r/);
  assert.match(dmarc!.value, /aspf=r/);
});

await test("a DMARC policy can be chosen, and no report address means no invented one", () => {
  const none = recordsMod.dnsRecords({ domain: "x.test", dkimTokens: [], mailFromLabel: "mail", region: "eu-west-1", dmarcPolicy: "none" });
  const record = none.find((r) => r.host === "_dmarc")!;
  assert.match(record.value, /p=none/);
  assert.equal(/rua=/.test(record.value), false);
});

await test("the MAIL FROM subdomain gets its own MX and its own SPF", () => {
  const mx = find("MX", "mail");
  assert.equal(mx?.value, "feedback-smtp.eu-west-1.amazonses.com");
  assert.equal(mx?.priority, 10);
  assert.equal(find("TXT", "mail")?.value, "v=spf1 include:amazonses.com -all");
});

await test("the root MX points at SES's inbound host, which is what makes replies possible", () => {
  const mx = RECORDS.find((r) => r.kind === "MX" && r.host === "@");
  assert.equal(mx?.value, "inbound-smtp.eu-west-1.amazonaws.com");
  assert.equal(mx?.priority, 10);
});

await test("a region that cannot receive mail is known about, not guessed at", () => {
  assert.equal(recordsMod.regionCanReceive("eu-west-1"), true);
  assert.equal(recordsMod.regionCanReceive("eu-central-1"), true);
  assert.equal(recordsMod.regionCanReceive("me-central-1"), false, "Bahrain and the UAE cannot receive");
});

await test("no inbound MX is printed for a send-only domain", () => {
  const sendOnly = recordsMod.dnsRecords({
    domain: "try-belline.com", dkimTokens: TOKENS, mailFromLabel: "mail", region: "eu-west-1", receivesReplies: false,
  });
  assert.equal(sendOnly.filter((r) => r.kind === "MX" && r.host === "@").length, 0);
  assert.equal(sendOnly.filter((r) => r.kind === "MX" && r.host === "mail").length, 1, "bounces still need a home");
});

await test("every record says what it is for", () => {
  for (const record of RECORDS) assert.ok(record.purpose.length > 15, `${record.kind} ${record.host}`);
});

await test("hosts are in Namecheap's form, not fully qualified", () => {
  assert.equal(recordsMod.hostFor("try-belline.com", "try-belline.com"), "@");
  assert.equal(recordsMod.hostFor("mail.try-belline.com", "try-belline.com"), "mail");
  assert.equal(recordsMod.hostFor("_dmarc.try-belline.com", "try-belline.com"), "_dmarc");
  for (const record of RECORDS) {
    assert.equal(/try-belline\.com$/.test(record.host), false, `${record.host} is fully qualified`);
  }
});

await test("the table is one row per record, with a priority column for the MX ones", () => {
  const table = recordsMod.asNamecheapTable(RECORDS);
  assert.equal(table.split("\n").length, RECORDS.length + 2);
  assert.match(table, /Type\s+Host\s+Value\s+Priority\s+TTL/);
  assert.match(table, /MX\s+@\s+inbound-smtp\.eu-west-1\.amazonaws\.com\s+10/);
});

await test("the zone file quotes TXT values and terminates the names", () => {
  const zone = recordsMod.asZoneFile(RECORDS);
  assert.match(zone, /_dmarc\.try-belline\.com\.\t\d+\tIN\tTXT\t"v=DMARC1/);
  assert.match(zone, /IN\tMX\t10 inbound-smtp\.eu-west-1\.amazonaws\.com\./);
});

// ---------------------------------------------------------------------------
section("Setting it up, against a stub SES");

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * A stub SES. It answers the way the real one does, including saying
 * "AlreadyExists" the second time — which is the case the command has to
 * survive, and the one nobody tests against a live account.
 */
function stubSes(state: { identity?: Record<string, unknown> | null; existing?: Set<string> } = {}) {
  const calls: Call[] = [];
  const existing = state.existing ?? new Set<string>();
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, path: pathname, body });

    if (init.method === "GET" && pathname === "/v2/email/account") {
      return new Response(JSON.stringify({ ProductionAccessEnabled: true, SendingEnabled: true }), { status: 200 });
    }
    if (init.method === "GET" && pathname.startsWith("/v2/email/identities/")) {
      if (!state.identity) {
        return new Response(JSON.stringify({ __type: "NotFoundException", message: "no such identity" }), { status: 404 });
      }
      return new Response(JSON.stringify(state.identity), { status: 200 });
    }
    if (existing.has(pathname)) {
      return new Response(JSON.stringify({ __type: "AlreadyExistsException", message: "it is already there" }), { status: 400 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const resolution = sesApiMod.sesApi({
    env: {
      OUTREACH_SES_ADMIN_ACCESS_KEY_ID: "AKIAEXAMPLE",
      OUTREACH_SES_ADMIN_SECRET_ACCESS_KEY: "secretexample",
      OUTREACH_SES_ADMIN_REGION: "eu-west-1",
    },
    fetchImpl,
  });
  assert.equal(resolution.ok, true);
  if (!resolution.ok) throw new Error("unreachable");
  return { api: resolution.api, calls };
}

await test("creating an identity asks for Easy DKIM with AWS-held keys", async () => {
  const { api, calls } = stubSes();
  await api.createIdentity("try-belline.com");
  const call = calls.at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/v2/email/identities");
  assert.deepEqual(call.body, {
    EmailIdentity: "try-belline.com",
    DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
  });
});

await test("the MAIL FROM falls back rather than rejecting when its MX disappears", async () => {
  // A silent SPF downgrade is bad. The whole sending pipeline stopping because
  // a DNS record was deleted is worse.
  const { api, calls } = stubSes();
  await api.setMailFrom("try-belline.com", "mail.try-belline.com");
  assert.deepEqual(calls.at(-1)!.body, {
    MailFromDomain: "mail.try-belline.com",
    BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
  });
});

await test("the event destination subscribes to bounce, complaint, delivery and reject", async () => {
  const { api, calls } = stubSes();
  await api.createEventDestination({
    configurationSet: "belline-cold-try-belline-com",
    name: "belline-events",
    topicArn: "arn:aws:sns:eu-west-1:1:events",
    eventTypes: sesApiMod.EVENT_TYPES,
  });
  const body = calls.at(-1)!.body as { EventDestination: { MatchingEventTypes: string[]; SnsDestination: { TopicArn: string } } };
  assert.deepEqual(body.EventDestination.MatchingEventTypes.sort(), ["BOUNCE", "COMPLAINT", "DELIVERY", "REJECT"]);
  assert.equal(body.EventDestination.SnsDestination.TopicArn, "arn:aws:sns:eu-west-1:1:events");
});

await test("an identity that exists already is read, not re-created", async () => {
  const { api } = stubSes({
    identity: {
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: "SUCCESS", Tokens: TOKENS },
      MailFromAttributes: { MailFromDomain: "mail.try-belline.com", MailFromDomainStatus: "SUCCESS" },
      ConfigurationSetName: "belline-cold-try-belline-com",
    },
  });
  const state = await api.getIdentity("try-belline.com");
  assert.equal(state?.verifiedForSending, true);
  assert.deepEqual(state?.dkimTokens, TOKENS);
});

await test("a missing identity is null, which is how a first run is told from a second", async () => {
  const { api } = stubSes({ identity: null });
  assert.equal(await api.getIdentity("try-belline.com"), null);
});

await test("\"already exists\" is done, not an error — the command is safe to re-run", async () => {
  const { api } = stubSes({ existing: new Set(["/v2/email/configuration-sets"]) });
  const result = await api.createConfigurationSet("belline-cold-try-belline-com");
  assert.equal(result.changed, false);
});

await test("a real refusal is still a refusal", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ __type: "BadRequestException", message: "nope" }), { status: 400 })) as unknown as typeof fetch;
  const resolution = sesApiMod.sesApi({
    env: {
      OUTREACH_SES_ADMIN_ACCESS_KEY_ID: "A", OUTREACH_SES_ADMIN_SECRET_ACCESS_KEY: "B", OUTREACH_SES_ADMIN_REGION: "eu-west-1",
    },
    fetchImpl,
  });
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;
  await assert.rejects(() => resolution.api.createConfigurationSet("x"), /BadRequestException/);
});

await test("every call is signed with the SES service and the region it was given", async () => {
  let authorization = "";
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    authorization = (init.headers as Record<string, string>).authorization;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const resolution = sesApiMod.sesApi({
    env: {
      OUTREACH_SES_ADMIN_ACCESS_KEY_ID: "AKIAEXAMPLE",
      OUTREACH_SES_ADMIN_SECRET_ACCESS_KEY: "secretexample",
      OUTREACH_SES_ADMIN_REGION: "eu-central-1",
    },
    fetchImpl,
  });
  if (!resolution.ok) throw new Error("unreachable");
  await resolution.api.createConfigurationSet("x");
  assert.match(authorization, /Credential=AKIAEXAMPLE\/\d{8}\/eu-central-1\/ses\/aws4_request/);
});

// ---------------------------------------------------------------------------
section("Checking it from outside");

function resolverFor(table: {
  cname?: Record<string, string[]>;
  txt?: Record<string, string[][]>;
  mx?: Record<string, { exchange: string; priority: number }[]>;
}): Resolver {
  const miss = () => {
    const err = new Error("not found") as Error & { code: string };
    err.code = "ENOTFOUND";
    throw err;
  };
  return {
    async resolveCname(name) {
      return table.cname?.[name] ?? miss();
    },
    async resolveTxt(name) {
      return table.txt?.[name] ?? miss();
    },
    async resolveMx(name) {
      return table.mx?.[name] ?? miss();
    },
  };
}

const PUBLISHED = {
  cname: Object.fromEntries(TOKENS.map((t) => [`${t}._domainkey.try-belline.com`, [`${t}.dkim.amazonses.com`]])),
  txt: {
    "try-belline.com": [["v=spf1 include:amazonses.com -all"]],
    "mail.try-belline.com": [["v=spf1 include:amazonses.com -all"]],
    "_dmarc.try-belline.com": [["v=DMARC1; p=quarantine; rua=mailto:dmarc@belline.ai; adkim=r; aspf=r; pct=100"]],
  },
  mx: {
    "try-belline.com": [{ exchange: "inbound-smtp.eu-west-1.amazonaws.com", priority: 10 }],
    "mail.try-belline.com": [{ exchange: "feedback-smtp.eu-west-1.amazonses.com", priority: 10 }],
  },
};

const CORRECT = resolverFor(PUBLISHED);

await test("a fully published domain comes back with nothing outstanding", async () => {
  const report = await verifyMod.checkAll(RECORDS, CORRECT);
  assert.equal(report.ok, true, report.outstanding.map((c) => `${c.record.host}: ${c.note}`).join("; "));
});

await test("a record nobody added is missing, and is named", async () => {
  const report = await verifyMod.checkAll(RECORDS, resolverFor({}));
  assert.equal(report.ok, false);
  assert.equal(report.outstanding.length, RECORDS.length);
  assert.match(report.checks[0].note, /nothing is published/);
});

await test("Namecheap's own parking and forwarding records read as wrong, not missing", async () => {
  // They are different problems: one is a record to add, the other is a
  // registrar default that has to be deleted first, and it silently wins.
  const resolver = resolverFor({
    ...PUBLISHED,
    mx: { "try-belline.com": [{ exchange: "eforward1.registrar-servers.com", priority: 10 }] },
  });
  const report = await verifyMod.checkAll(RECORDS, resolver);
  const root = report.checks.find((c) => c.record.kind === "MX" && c.record.host === "@")!;
  assert.equal(root.verdict, "wrong");
  assert.match(root.note, /eforward1/);
  assert.match(root.note, /delete it/);
});

await test("a TXT record split across chunks is joined before it is compared", async () => {
  // DNS splits a string over 255 bytes, and a check that compares the first
  // chunk reports a correct record as wrong.
  const resolver = resolverFor({
    txt: { "_dmarc.try-belline.com": [["v=DMARC1; p=quarantine; rua=mailto:dmarc@belline.ai;", " adkim=r; aspf=r; pct=100"]] },
  });
  const check = await verifyMod.checkRecord(find("TXT", "_dmarc")!, resolver);
  assert.equal(check.verdict, "ok");
});

await test("whitespace and a trailing semicolon do not make a correct record look wrong", async () => {
  const resolver = resolverFor({
    txt: { "try-belline.com": [["v=spf1  include:amazonses.com   -all"]] },
  });
  const check = await verifyMod.checkRecord(find("TXT", "@")!, resolver);
  assert.equal(check.verdict, "ok");
});

await test("a resolver that fails is unchecked, not missing", async () => {
  const check = await verifyMod.checkRecord(find("TXT", "@")!, {
    async resolveCname() { throw new Error("SERVFAIL"); },
    async resolveTxt() { throw new Error("SERVFAIL"); },
    async resolveMx() { throw new Error("SERVFAIL"); },
  });
  assert.equal(check.verdict, "unchecked");
});

await test("SES's own view is reported separately from DNS, and in sentences", () => {
  const ready = verifyMod.describeIdentity({
    verifiedForSending: true, dkimStatus: "SUCCESS", mailFromDomain: "mail.try-belline.com",
    mailFromStatus: "SUCCESS", configurationSet: "belline-cold",
  });
  assert.equal(ready.every((v) => v.ok), true);
  const pending = verifyMod.describeIdentity({
    verifiedForSending: false, dkimStatus: "PENDING", mailFromDomain: null, mailFromStatus: null, configurationSet: null,
  });
  assert.equal(pending.some((v) => v.ok), false);
  assert.match(pending[0].line, /re-checks on its own|wait/i);
  assert.match(pending[2].line, /SPF will not align/);
  assert.match(pending[3].line, /bounces and complaints will not reach us/);
  assert.match(verifyMod.describeIdentity(null)[0].line, /run the setup command first/);
});

// ---------------------------------------------------------------------------
section("The commands themselves");

const setup = read("scripts/domain-setup.ts");
const verifyScript = read("scripts/domain-verify.ts");

await test("belline.ai is refused, in code, before anything happens", () => {
  assert.match(setup, /belline\\\.ai/);
  assert.match(setup, /must never send cold mail/i);
  // Before the SES client is resolved, not after.
  assert.ok(setup.indexOf("belline\\.ai") < setup.indexOf("sesApi()"), "the refusal must come first");
});

await test("both commands are registered, in the existing style", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["domain:setup"], "node --import tsx --env-file-if-exists=.env scripts/domain-setup.ts");
  assert.equal(pkg.scripts["domain:verify"], "node --import tsx --env-file-if-exists=.env scripts/domain-verify.ts");
  assert.equal(pkg.scripts["check:domain-setup"], "node --import tsx scripts/check-domain-setup.ts");
  assert.equal(pkg.scripts["check:inbound-mail"], "node --import tsx scripts/check-inbound-mail.ts");
  assert.match(pkg.scripts["check:all"], /check:inbound-mail/);
  assert.match(pkg.scripts["check:all"], /check:domain-setup/);
});

await test("the setup command registers the domain and its mailboxes with a warm-up date", () => {
  assert.match(setup, /addDomain/);
  assert.match(setup, /addMailbox/);
  assert.match(setup, /warmupStartedOn: today/);
});

await test("it says what only a person can give, before it does anything", () => {
  assert.match(setup, /whatOnlyAPersonKnows/);
  assert.ok(setup.indexOf("whatOnlyAPersonKnows") < setup.indexOf("const resolution = sesApi()"));
  const inputs = recordsMod.whatOnlyAPersonKnows({ domain: "x.test", mailboxes: [] });
  assert.ok(inputs.length >= 4);
  for (const item of inputs) assert.ok(item.why.length > 20, item.label);
});

await test("a dry run prints no DKIM records rather than fictional ones", () => {
  assert.match(setup, /dry-run/);
  assert.match(setup, /not printed rather than made up/);
});

await test("the verify command checks from a third-party resolver, not this machine's", () => {
  assert.match(verifyScript, /setServers/);
  assert.match(verifyScript, /1\.1\.1\.1/);
});

await test("the verify command exits non-zero while anything is outstanding", () => {
  assert.match(verifyScript, /process\.exit\(report\.ok && sesReady \? 0 : 1\)/);
});

// ---------------------------------------------------------------------------
section("Nothing here can reach AWS without explicit credentials");

await test("with no credentials the SES client refuses, and names the variables", () => {
  const result = sesApiMod.sesApi({ env: {} });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.missing, [
    "OUTREACH_SES_ADMIN_ACCESS_KEY_ID",
    "OUTREACH_SES_ADMIN_SECRET_ACCESS_KEY",
    "OUTREACH_SES_ADMIN_REGION",
  ]);
  assert.equal("api" in result, false, "a refusal must never carry a client");
});

await test("the admin keys are separate from the sending keys", () => {
  // The key that can create an identity and rewrite a configuration set is far
  // more dangerous than the one that can send a message. A deployment holds
  // the second; a laptop holds the first.
  const sending = sesApiMod.sesApi({
    env: {
      OUTREACH_SES_TRY_BELLINE_COM_ACCESS_KEY_ID: "A",
      OUTREACH_SES_TRY_BELLINE_COM_SECRET_ACCESS_KEY: "B",
      OUTREACH_SES_TRY_BELLINE_COM_REGION: "eu-west-1",
      OUTREACH_SES_ACCESS_KEY_ID: "A",
      OUTREACH_SES_SECRET_ACCESS_KEY: "B",
      OUTREACH_SES_REGION: "eu-west-1",
    },
  });
  assert.equal(sending.ok, false, "sending credentials must not unlock the control plane");
});

await test("only one module constructs the SES control-plane client", () => {
  const files = walk(path.join(ROOT, "src"), /\.tsx?$/);
  const importers = files
    .filter((f) => /\bsesApi\s*\(/.test(code(fs.readFileSync(f, "utf8"))))
    .map((f) => path.relative(ROOT, f).replaceAll("\\", "/"))
    .sort();
  assert.deepEqual(importers, ["src/lib/sales/sending/provisioning/sesApi.ts"]);
});

await test("no web route can reach the control plane at all", () => {
  // Domain setup is a command a person runs, deliberately, on a laptop. An
  // HTTP route that could create an SES identity is a different risk entirely.
  const routes = walk(path.join(ROOT, "src", "app"), /^route\.ts$/);
  for (const file of routes) {
    assert.equal(
      /provisioning\/sesApi/.test(fs.readFileSync(file, "utf8")),
      false,
      path.relative(ROOT, file),
    );
  }
});

await test("the provisioning modules read no environment variable of their own", () => {
  for (const file of walk(path.join(ROOT, "src", "lib", "sales", "sending", "provisioning"), /\.ts$/)) {
    const relative = path.relative(ROOT, file).replaceAll("\\", "/");
    const source = code(fs.readFileSync(file, "utf8"));
    const reads = (source.match(/process\.env/g) ?? []).length;
    // The two permitted shapes, both of which are a caller-supplied argument
    // falling back: `env: Env = process.env` and `input.env ?? process.env`.
    const defaults = (source.match(/(?:\?\?|=)\s*process\.env/g) ?? []).length;
    assert.equal(reads, defaults, `${relative} reads process.env outside a defaulted argument`);
  }
});

await test("the pure record and verify modules touch no network primitive at all", () => {
  for (const rel of [
    "src/lib/sales/sending/provisioning/records.ts",
    "src/lib/sales/sending/provisioning/verify.ts",
  ]) {
    const source = code(read(rel));
    assert.equal(/\bfetch\s*\(/.test(source), false, `${rel} calls fetch`);
    assert.equal(/require\(["']node:dns|from ["']node:dns/.test(source), false, `${rel} resolves DNS itself`);
  }
});

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
if (failed > 0) process.exitCode = 1;
