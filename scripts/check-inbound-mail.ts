/**
 * Inbound mail (src/lib/sales/inbound).
 *
 * The outreach engine could already put a message in a stranger's inbox. This
 * is the half that hears the answer, and the ways it can be a disaster are not
 * the same ones:
 *
 *  - an **out-of-office read as a reply**, which stops the sequence for good
 *    and loses the lead with no error anywhere for anybody to notice;
 *  - our **own footer, quoted back**, read as an unsubscribe and suppressing a
 *    company that wanted a call;
 *  - a **forged notification** stopping a sequence or suppressing a company,
 *    because the endpoint is a public URL and anybody can POST to it;
 *  - a **redelivered notification** counted twice, which SNS guarantees will
 *    happen;
 *  - a **reply nobody can attribute** being dropped instead of shown;
 *  - a **temporary bounce** suppressing an address that was only full.
 *
 * Nothing here touches the network, AWS or a database. `globalThis.fetch`
 * throws, there are no credentials, and the last section proves that no code
 * path could have reached AWS even if one had tried.
 *
 *   npm run check:inbound-mail
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-inbound-"));
delete process.env.DATABASE_URL;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("OUTREACH_") || key.startsWith("LEGAL_") || key.startsWith("AWS_")) delete process.env[key];
}
Object.assign(process.env, {
  FLAG_STUBS: "on",
  PUBLIC_ORIGIN: "https://app.belline.test",
  SENDER_POSTAL_ADDRESS: "Belline · Dubai, United Arab Emirates",
  OUTREACH_UNSUBSCRIBE_SECRET: "s3cret",
});

const NETWORK_OFF = () => {
  throw new Error("network is off in check:inbound-mail");
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

/** Comments here quote the patterns the scans look for. Read code only. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const mime = await import("../src/lib/sales/inbound/mime");
const classifyMod = await import("../src/lib/sales/inbound/classify");
const snsMod = await import("../src/lib/sales/inbound/sns");
type SnsEnvelope = import("../src/lib/sales/inbound/sns").SnsEnvelope;
const s3Mod = await import("../src/lib/sales/inbound/s3");
const receiveMod = await import("../src/lib/sales/inbound/receive");
const threading = await import("../src/lib/sales/sending/threading");
const sequence = await import("../src/lib/sales/sending/sequence");
const storeMod = await import("../src/lib/sales/sending/store");
type SendingStore = import("../src/lib/sales/sending/store").SendingStore;
type SendItem = import("../src/lib/sales/sending/store").SendItem;
const batchMod = await import("../src/lib/sales/sending/batch");
const dispatchMod = await import("../src/lib/sales/sending/dispatch");
const providerMod = await import("../src/lib/sales/sending/provider");
const compliance = await import("../src/lib/sales/sending/compliance");
const countries = await import("../src/lib/sales/sending/countries");

const ENV = { OUTREACH_UNSUBSCRIBE_SECRET: "s3cret" };

// ---------------------------------------------------------------------------
section("The webhook cannot be forged");

/**
 * A keypair and a signer standing in for AWS. Real RSA, real signatures — the
 * only thing simulated is who owns the key.
 */
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const CERT_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const TOPIC = "arn:aws:sns:eu-west-1:123456789012:belline-inbound";

function signEnvelope(over: Partial<SnsEnvelope> = {}): SnsEnvelope {
  const envelope = {
    Type: "Notification",
    MessageId: crypto.randomUUID(),
    TopicArn: TOPIC,
    Message: "{}",
    Timestamp: new Date().toISOString(),
    SignatureVersion: "1",
    Signature: "",
    SigningCertURL: "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem",
    ...over,
  } as SnsEnvelope;
  const signer = crypto.createSign(envelope.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1");
  signer.update(snsMod.canonicalString(envelope), "utf8");
  envelope.Signature = signer.sign(privateKey, "base64");
  return envelope;
}

const fetchCert = async () => CERT_PEM;
const verify = (envelope: SnsEnvelope, over: Partial<Parameters<typeof snsMod.verifySns>[0]> = {}) =>
  snsMod.verifySns({ envelope, allowedTopics: [TOPIC], fetchCert, ...over });

await test("a genuine notification verifies", async () => {
  assert.deepEqual(await verify(signEnvelope()), { ok: true });
});

await test("SignatureVersion 2 (SHA-256) verifies too", async () => {
  assert.deepEqual(await verify(signEnvelope({ SignatureVersion: "2" })), { ok: true });
});

await test("a tampered Message is refused", async () => {
  const envelope = signEnvelope({ Message: '{"a":1}' });
  const result = await verify({ ...envelope, Message: '{"a":2}' });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /does not verify/);
});

await test("a signature from somebody else's key is refused", async () => {
  const envelope = signEnvelope();
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const result = await verify(envelope, {
    fetchCert: async () => other.publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  assert.equal(result.ok, false);
});

await test("a certificate URL that is not AWS is refused before it is fetched", async () => {
  // The URL comes out of the message, so it is attacker-controlled. Without
  // this check an attacker signs with their own key and hands us their own
  // certificate, and everything verifies perfectly.
  for (const url of [
    "https://sns.amazonaws.com.attacker.test/cert.pem",
    "http://sns.eu-west-1.amazonaws.com/cert.pem",
    "https://attacker.test/sns.eu-west-1.amazonaws.com.pem",
    "https://evil.test/cert.pem",
  ]) {
    assert.equal(snsMod.certUrlIsAws(url), false, url);
    const result = await verify(signEnvelope({ SigningCertURL: url }), {
      fetchCert: async () => {
        throw new Error("the certificate must not be fetched");
      },
    });
    assert.equal(result.ok, false, url);
    assert.match((result as { reason: string }).reason, /not an AWS one/);
  }
  assert.equal(snsMod.certUrlIsAws("https://sns.eu-west-1.amazonaws.com/x.pem"), true);
});

await test("a valid signature on somebody else's topic is refused", async () => {
  const result = await verify(signEnvelope({ TopicArn: "arn:aws:sns:eu-west-1:999:someone-else" }));
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /not one this endpoint accepts/);
});

await test("with no topic configured, nothing is accepted at all", async () => {
  const result = await verify(signEnvelope(), { allowedTopics: [] });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /OUTREACH_INBOUND_SNS_TOPIC_ARN/);
});

await test("a replayed notification from an hour ago is refused", async () => {
  const old = new Date(Date.now() - 3_600_000).toISOString();
  const result = await verify(signEnvelope({ Timestamp: old }));
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /minutes old/);
});

await test("a notification timestamped in the future is refused", async () => {
  const ahead = new Date(Date.now() + 3_600_000).toISOString();
  const result = await verify(signEnvelope({ Timestamp: ahead }));
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /future/);
});

await test("the canonical string omits an absent Subject rather than signing an empty one", () => {
  const withSubject = snsMod.canonicalString({ ...signEnvelope({ Subject: "hi" }) });
  const without = snsMod.canonicalString({ ...signEnvelope() });
  assert.match(withSubject, /\nSubject\nhi\n/);
  assert.equal(/Subject/.test(without), false);
});

await test("a subscription confirmation signs a different field list, and verifies", async () => {
  const envelope = signEnvelope({
    Type: "SubscriptionConfirmation",
    Token: "tok",
    SubscribeURL: "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription",
  });
  assert.deepEqual(await verify(envelope), { ok: true });
  assert.match(snsMod.canonicalString(envelope), /SubscribeURL/);
});

// ---------------------------------------------------------------------------
section("A reply can be traced to the message it answers");

await test("a Message-ID round-trips to its send item", () => {
  const id = threading.mintMessageId(42, "try-belline.com", ENV);
  assert.match(id, /@try-belline\.com$/);
  assert.equal(threading.parseMessageId(`<${id}>`, ENV), 42);
  assert.equal(threading.parseMessageId(id, ENV), 42);
});

await test("a Message-ID with a forged signature names nobody", () => {
  // Otherwise anybody could stop any sequence by guessing an item id and
  // putting it in In-Reply-To.
  const id = threading.mintMessageId(42, "try-belline.com", ENV);
  assert.equal(threading.parseMessageId(id.replace(/^blt1\.b42\./, "blt1.b43."), ENV), null);
  assert.equal(threading.parseMessageId("blt1.b42.000000000000.aa@try-belline.com", ENV), null);
  assert.equal(threading.parseMessageId(id, { OUTREACH_UNSUBSCRIBE_SECRET: "other" }), null);
});

await test("the plus-address round-trips and survives being lower-cased", () => {
  const token = threading.mintReplyToken(7, ENV);
  const address = threading.plusAddress("Andreas@Try-Belline.com", token);
  assert.match(address, /^Andreas\+b7\./);
  assert.equal(threading.verifyReplyToken(threading.tokenInAddress(address.toLowerCase())!, ENV), 7);
  assert.equal(threading.baseAddress(address), "andreas@try-belline.com");
});

await test("a plus-address nobody signed names nobody", () => {
  assert.equal(threading.verifyReplyToken("b7.deadbeefcafe", ENV), null);
  assert.equal(threading.tokenInAddress("andreas@try-belline.com"), null);
});

await test("two sends never share a Message-ID", () => {
  const a = threading.mintMessageId(1, "try-belline.com", ENV);
  const b = threading.mintMessageId(1, "try-belline.com", ENV);
  assert.notEqual(a, b);
  assert.equal(threading.parseMessageId(a, ENV), threading.parseMessageId(b, ENV));
});

// ---------------------------------------------------------------------------
section("Reading a real message");

const PLAIN = [
  "Return-Path: <info@jumeirah-dental.test>",
  "From: Dr Khan <info@jumeirah-dental.test>",
  "To: andreas+b1.abc@try-belline.com",
  "Subject: Re: a 2-minute demo",
  "Message-ID: <reply-1@jumeirah-dental.test>",
  "In-Reply-To: <blt1.b1.abc.nonce@try-belline.com>",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "Sounds interesting, call me Thursday.",
].join("\r\n");

await test("From, To, Subject and the threading headers come out", () => {
  const parsed = mime.parseMessage(PLAIN);
  assert.equal(parsed.from, "info@jumeirah-dental.test");
  assert.equal(parsed.fromName, "Dr Khan");
  assert.equal(parsed.subject, "Re: a 2-minute demo");
  assert.equal(parsed.inReplyTo, "blt1.b1.abc.nonce@try-belline.com");
  assert.match(parsed.text, /call me Thursday/);
  assert.ok(parsed.to.includes("andreas+b1.abc@try-belline.com"));
});

await test("a folded header is unfolded, not truncated", () => {
  // Outlook folds long References headers, and a parser that reads only the
  // first line threads nothing.
  const raw = [
    "From: a@b.test",
    "References: <one@x.test>",
    "\t<two@x.test>",
    " <three@x.test>",
    "Subject: hi",
    "",
    "body",
  ].join("\r\n");
  const parsed = mime.parseMessage(raw);
  assert.deepEqual(parsed.references, ["one@x.test", "two@x.test", "three@x.test"]);
});

await test("an encoded subject is decoded, in base64 and in quoted-printable", () => {
  assert.equal(mime.decodeWords("=?UTF-8?B?QXV0b21hdGlzY2hlIEFudHdvcnQ=?="), "Automatische Antwort");
  assert.equal(mime.decodeWords("=?UTF-8?Q?R=C3=A9ponse_automatique?="), "Réponse automatique");
});

await test("a base64 body is decoded", () => {
  const raw = [
    "From: a@b.test",
    "Subject: hi",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("Nicht interessiert, danke.", "utf8").toString("base64"),
  ].join("\r\n");
  assert.match(mime.parseMessage(raw).text, /Nicht interessiert/);
});

await test("a quoted-printable body is decoded", () => {
  const raw = [
    "From: a@b.test",
    "Subject: hi",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Ich bin bis zum 05.10.2026 nicht im B=C3=BCro.",
  ].join("\r\n");
  assert.match(mime.parseMessage(raw).text, /nicht im Büro/);
});

await test("multipart/alternative gives the plain part, not the HTML one", () => {
  const raw = [
    "From: a@b.test",
    "Subject: hi",
    'Content-Type: multipart/alternative; boundary="B1"',
    "",
    "--B1",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "the plain words",
    "--B1",
    "Content-Type: text/html; charset=UTF-8",
    "",
    "<p>the html words</p>",
    "--B1--",
  ].join("\r\n");
  const parsed = mime.parseMessage(raw);
  assert.match(parsed.text, /the plain words/);
  assert.equal(/html words/.test(parsed.text), false);
});

await test("an HTML-only message is still readable", () => {
  const raw = [
    "From: a@b.test",
    "Subject: hi",
    "Content-Type: text/html; charset=UTF-8",
    "",
    "<div>Please <b>take me off</b> your list.</div>",
  ].join("\r\n");
  assert.match(mime.parseMessage(raw).text, /take me off your list/);
});

await test("a nested multipart does not run away with the stack", () => {
  let raw = "the words";
  for (let i = 0; i < 40; i++) {
    raw = [`Content-Type: multipart/mixed; boundary="B${i}"`, "", `--B${i}`, raw, `--B${i}--`].join("\r\n");
  }
  const parsed = mime.parseMessage(`From: a@b.test\r\nSubject: hi\r\n${raw}`);
  assert.ok(parsed.text.length >= 0);
});

// ---------------------------------------------------------------------------
section("Our own words, quoted back, are not their words");

const OUR_FOOTER =
  "—\nBelline FZ-LLC · Dubai\n\nNot for you? Unsubscribe — one click, and I will not write again: https://app.belline.test/u/blu1.x";

await test("a Gmail-style quote is cut off", () => {
  const body = `Yes please, Thursday works.\n\nOn Mon, 21 Sep 2026 at 09:30, Andreas <andreas@try-belline.com> wrote:\n> ${OUR_FOOTER}`;
  const stripped = mime.stripQuoted(body);
  assert.equal(stripped, "Yes please, Thursday works.");
  assert.equal(/Unsubscribe/.test(stripped), false);
});

await test("a German and a French quote marker are cut off too", () => {
  assert.equal(
    mime.stripQuoted(`Gerne, Donnerstag passt.\n\nAm 21.09.2026 schrieb Andreas:\n> ${OUR_FOOTER}`),
    "Gerne, Donnerstag passt.",
  );
  assert.equal(
    mime.stripQuoted(`Oui, avec plaisir.\n\nLe 21 sept. 2026, Andreas a écrit :\n> ${OUR_FOOTER}`),
    "Oui, avec plaisir.",
  );
});

await test("an Outlook From:/Sent: block is cut off", () => {
  const body = `Thanks, interested.\n\nFrom: Andreas <andreas@try-belline.com>\nSent: Monday 21 September 2026 09:30\nTo: Dr Khan\nSubject: a demo\n\n${OUR_FOOTER}`;
  assert.equal(mime.stripQuoted(body), "Thanks, interested.");
});

await test("a friendly reply quoting our footer is not an opt-out", () => {
  // The single most expensive false positive available: the word
  // "unsubscribe" is in every message we send.
  const raw = [
    "From: Dr Khan <info@jumeirah-dental.test>",
    "Subject: Re: a demo",
    "Content-Type: text/plain",
    "",
    "Looks good — can you call me Thursday?",
    "",
    "On Mon, 21 Sep 2026 at 09:30, Andreas wrote:",
    `> ${OUR_FOOTER.replace(/\n/g, "\n> ")}`,
  ].join("\r\n");
  const verdict = classifyMod.classify({ message: mime.parseMessage(raw) });
  assert.equal(verdict.kind, "reply");
  assert.equal(verdict.optOut, "none");
});

await test("when no quote marker matches, the whole text is kept", () => {
  assert.equal(mime.stripQuoted("just one line"), "just one line");
});

// ---------------------------------------------------------------------------
section("An auto-reply is not a reply");

function message(headers: string[], body: string) {
  return mime.parseMessage([...headers, "Content-Type: text/plain; charset=UTF-8", "", body].join("\r\n"));
}

await test("Auto-Submitted says so, and is believed", () => {
  const verdict = classifyMod.classify({
    message: message(["From: a@b.test", "Subject: Re: a demo", "Auto-Submitted: auto-replied"], "I am away."),
  });
  assert.equal(verdict.kind, "auto_reply");
  assert.match(verdict.why, /Auto-Submitted/);
});

await test("Auto-Submitted: no is a person, not a machine", () => {
  const verdict = classifyMod.classify({
    message: message(["From: a@b.test", "Subject: Re: a demo", "Auto-Submitted: no"], "Sure, call me."),
  });
  assert.equal(verdict.kind, "reply");
});

await test("the usual auto-reply subjects are caught, in four languages", () => {
  for (const subject of [
    "Automatic reply: a 2-minute demo",
    "Out of Office: a demo",
    "Automatische Antwort: ein Demo",
    "Abwesenheitsnotiz",
    "Réponse automatique : une démo",
    "رد تلقائي",
  ]) {
    const verdict = classifyMod.classify({ message: message(["From: a@b.test", `Subject: ${subject}`], "…") });
    assert.equal(verdict.kind, "auto_reply", subject);
  }
});

await test("an out-of-office with no telltale header or subject is caught by what it says", () => {
  for (const body of [
    "Thank you for your email. I am out of the office until further notice.",
    "Ich bin derzeit nicht im Büro und ab dem 5. Oktober wieder erreichbar.",
    "Je suis actuellement absent du bureau.",
  ]) {
    const verdict = classifyMod.classify({ message: message(["From: a@b.test", "Subject: Re: demo"], body) });
    assert.equal(verdict.kind, "auto_reply", body);
  }
});

await test("an empty Return-Path means a machine sent it", () => {
  const verdict = classifyMod.classify({
    message: message(["From: a@b.test", "Subject: Re: demo", "Return-Path: <>"], "Anything at all."),
  });
  assert.equal(verdict.kind, "auto_reply");
});

await test("the date they say they are back is read, in three formats", () => {
  const now = new Date("2026-09-21T08:00:00Z");
  const iso = classifyMod.returnDate("I am back on 2026-10-05.", now);
  assert.equal(iso?.toISOString().slice(0, 10), "2026-10-05");
  const german = classifyMod.returnDate("Ich bin bis zum 05.10.2026 abwesend.", now);
  assert.equal(german?.toISOString().slice(0, 10), "2026-10-05");
  const named = classifyMod.returnDate("Back in the office on 5 October.", now);
  assert.equal(named?.toISOString().slice(0, 10), "2026-10-05");
});

await test("a date in the past, or years away, is not believed", () => {
  const now = new Date("2026-09-21T08:00:00Z");
  assert.equal(classifyMod.returnDate("Sent 2026-01-02", now), null);
  assert.equal(classifyMod.returnDate("Our contract runs to 2029-01-01", now), null);
});

// ---------------------------------------------------------------------------
section("Bounces and complaints");

function dsn(status: string, action: string, recipient = "info@jumeirah-dental.test") {
  return [
    "From: MAILER-DAEMON@amazonses.com",
    "Subject: Delivery Status Notification (Failure)",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="R1"',
    "",
    "--R1",
    "Content-Type: text/plain",
    "",
    "Your message could not be delivered.",
    "--R1",
    "Content-Type: message/delivery-status",
    "",
    `Final-Recipient: rfc822; ${recipient}`,
    `Action: ${action}`,
    `Status: ${status}`,
    "Diagnostic-Code: smtp; 550 5.1.1 user unknown",
    "--R1--",
  ].join("\r\n");
}

await test("a 5.x.x delivery report is a permanent bounce, and names the address", () => {
  const verdict = classifyMod.classify({ message: mime.parseMessage(dsn("5.1.1", "failed")) });
  assert.equal(verdict.kind, "bounce");
  assert.equal(verdict.permanentFailure, true);
  assert.equal(verdict.failedRecipient, "info@jumeirah-dental.test");
});

await test("a 4.x.x delivery report is temporary and suppresses nobody", () => {
  const verdict = classifyMod.classify({ message: mime.parseMessage(dsn("4.2.2", "delayed")) });
  assert.equal(verdict.kind, "bounce");
  assert.equal(verdict.permanentFailure, false);
});

await test("a bounce-shaped message with no machine-readable report is read as temporary", () => {
  // A subject line is not evidence enough to delete a prospect.
  const verdict = classifyMod.classify({
    message: message(["From: postmaster@x.test", "Subject: Undeliverable: a demo"], "It did not go."),
  });
  assert.equal(verdict.kind, "bounce");
  assert.equal(verdict.permanentFailure, false);
});

await test("an abuse feedback report is a complaint", () => {
  const raw = [
    "From: feedback@isp.test",
    "Subject: FW: complaint",
    'Content-Type: multipart/report; report-type=feedback-report; boundary="F1"',
    "",
    "--F1",
    "Content-Type: message/feedback-report",
    "",
    "Feedback-Type: abuse",
    "--F1--",
  ].join("\r\n");
  // The report type is on the outer content type; the inner part names it too.
  const parsed = mime.parseMessage(raw);
  const verdict = classifyMod.classify({
    message: { ...parsed, contentType: "message/feedback-report" },
  });
  assert.equal(verdict.kind, "complaint");
});

// ---------------------------------------------------------------------------
section("Asking to stop, in prose");

await test("an unmistakable opt-out is certain", () => {
  for (const body of ["Please take me off your list.", "Unsubscribe me.", "Bitte abmelden.", "لا تراسلني"]) {
    const verdict = classifyMod.classify({ message: message(["From: a@b.test", "Subject: Re"], body) });
    assert.equal(verdict.optOut, "certain", body);
  }
});

await test("an ambiguous one is only likely, and goes to a person", () => {
  for (const body of [
    "Not interested, thanks.",
    "How did you get my email?",
    "She no longer works here.",
    "Kein Interesse.",
  ]) {
    const verdict = classifyMod.classify({ message: message(["From: a@b.test", "Subject: Re"], body) });
    assert.equal(verdict.optOut, "likely", body);
  }
});

await test("an ordinary reply is neither", () => {
  const verdict = classifyMod.classify({
    message: message(["From: a@b.test", "Subject: Re"], "Interesting — what does it cost?"),
  });
  assert.equal(verdict.optOut, "none");
});

// ---------------------------------------------------------------------------
section("A reply, end to end");

const CANDIDATE = {
  leadId: 501,
  companyId: 9001,
  companyName: "Jumeirah Dental",
  toAddress: "info@jumeirah-dental.test",
  countryCode: "AE",
  messageId: 1,
  subject: "a 2-minute demo for Jumeirah Dental",
  body: "Hello,\n\nA short note about your evening calls.\n\n▶ Listen: https://app.belline.test/demo/v/abc\n\nAndreas\nBelline\n\n—\nplaceholder footer\n",
  videoDemoId: "abc",
  demoUrl: "https://app.belline.test/demo/v/abc",
  hasResearch: true,
  guardProblems: [] as string[],
  suppressed: null as string | null,
  touches90d: 0,
  lastTouchAt: null as string | null,
  sequenceStopped: null as string | null,
};

const BATCH_ENV = {
  LEGAL_ENTITY: "Belline FZ-LLC",
  LEGAL_ADDRESS: "Office 1, Dubai, United Arab Emirates",
  LEGAL_MANAGING_DIRECTOR: "Andreas Baidas",
  // Not "DED-000000": a run of identical digits is what the privacy notice's
  // placeholder check refuses to publish, and a fixture that trips it would
  // block every batch here on no_privacy_notice — failing these tests for a
  // reason that has nothing to do with inbound mail.
  LEGAL_REGISTRATION: "DED-1184713",
  LEGAL_EMAIL: "hello@belline.ai",
  OUTREACH_UNSUBSCRIBE_SECRET: "s3cret",
  OUTREACH_SES_TRY_BELLINE_COM_ACCESS_KEY_ID: "AKIAEXAMPLE",
  OUTREACH_SES_TRY_BELLINE_COM_SECRET_ACCESS_KEY: "secretexample",
  OUTREACH_SES_TRY_BELLINE_COM_REGION: "eu-west-1",
};

const MONDAY = new Date("2026-09-21T05:30:00Z");

/** A seeded engine with one message actually sent through a stub adapter. */
async function sent() {
  storeMod.resetMemoryStore();
  const store = storeMod.sendingStore();
  const domain = await store.addDomain({
    domain: "try-belline.com", provider: "ses", purpose: "cold", status: "active",
    dailyCap: 120, dns: {}, notes: null, pausedReason: null, pausedAt: null,
  });
  const box = await store.addMailbox({
    domainId: domain.id, address: "andreas@try-belline.com", displayName: "Andreas Baidas",
    replyTo: null, dailyCap: 30, warmupStartedOn: "2026-01-01", status: "active",
    pausedReason: null, pausedAt: null,
  });
  await store.setCountryOverride({ code: "AE", enabled: true, dailyCap: 240, updatedBy: "test" });

  const { fixedSource } = await import("../src/lib/sales/sending/candidates");
  const built = await batchMod.buildBatch({
    source: fixedSource([CANDIDATE] as never),
    store, origin: "https://app.belline.test", env: BATCH_ENV, now: MONDAY, limit: 10,
  });
  const { batch, items } = await batchMod.saveBatch({
    built, createdBy: "user:test", origin: "https://app.belline.test", store, env: BATCH_ENV,
  });
  await store.approveBatch(batch.id, "user:andreas");
  const stub = providerMod.stubAdapter("try-belline.com");
  const outcome = await dispatchMod.dispatch(items[0], box, stub, {
    store, env: BATCH_ENV, origin: "https://app.belline.test", now: MONDAY,
  });
  assert.equal(outcome.ok, true, (outcome as { reason?: string }).reason);
  const item = (await store.getItem(items[0].id))!;
  return { store, box, item, stub };
}

/** A follow-up already on the clock for the same lead. */
async function queueFollowUp(store: SendingStore, item: SendItem, at: string) {
  const [row] = await store.addItems([
    { ...item, id: undefined, step: 2, status: "queued", sentAt: null, scheduledFor: at,
      rfcMessageId: null, replyToken: null, providerMsgId: null } as never,
  ]);
  return row;
}

function inbound(over: { from?: string; subject?: string; body?: string; headers?: string[]; inReplyTo?: string | null; to?: string }) {
  return [
    `From: ${over.from ?? "Dr Khan <info@jumeirah-dental.test>"}`,
    `To: ${over.to ?? "andreas@try-belline.com"}`,
    `Subject: ${over.subject ?? "Re: a 2-minute demo"}`,
    `Message-ID: <${crypto.randomUUID()}@jumeirah-dental.test>`,
    ...(over.inReplyTo === null ? [] : [`In-Reply-To: <${over.inReplyTo}>`]),
    ...(over.headers ?? []),
    "Content-Type: text/plain; charset=UTF-8",
    "",
    over.body ?? "Sounds interesting, call me Thursday.",
  ].join("\r\n");
}

await test("the sent message carries the Message-ID and Reply-To we can trace", async () => {
  const { item, stub } = await sent();
  assert.ok(item.rfcMessageId, "the item must remember its Message-ID");
  assert.ok(item.replyToken, "the item must remember its reply token");
  assert.equal(stub.sent[0].messageId, item.rfcMessageId);
  assert.match(stub.sent[0].replyTo ?? "", /^andreas\+b\d+\./);
  assert.equal(threading.parseMessageId(item.rfcMessageId!, BATCH_ENV), item.id);
});

await test("a reply threaded on In-Reply-To stops the sequence and takes queued items off the clock", async () => {
  const { store, item } = await sent();
  await queueFollowUp(store, item, "2026-09-25T06:00:00Z");
  const outcome = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-1", raw: inbound({ inReplyTo: item.rfcMessageId! }),
    recipients: ["andreas@try-belline.com"], store, env: BATCH_ENV,
  });
  assert.equal(outcome.action, "stopped");
  assert.equal(outcome.matchedBy, "thread");
  assert.equal(outcome.leadId, 501);
  const state = await store.getSequence(501);
  assert.equal(state?.status, "stopped");
  assert.equal(state?.stopReason, "replied");
  assert.equal((await store.listItems({ leadId: 501, status: ["planned", "queued"] })).length, 0);
  const [recorded] = await store.listReplies({ limit: 10 });
  assert.equal(recorded.kind, "reply");
  assert.match(recorded.body, /call me Thursday/);
});

await test("a reply with no threading headers is found by the plus-address", async () => {
  const { store, item } = await sent();
  const outcome = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-2",
    raw: inbound({ inReplyTo: null, to: threading.plusAddress("andreas@try-belline.com", item.replyToken!) }),
    recipients: [threading.plusAddress("andreas@try-belline.com", item.replyToken!)],
    store, env: BATCH_ENV,
  });
  assert.equal(outcome.matchedBy, "plus_address");
  assert.equal(outcome.leadId, 501);
});

await test("a reply with neither is found by the address, as a last resort", async () => {
  const { store } = await sent();
  const outcome = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-3", raw: inbound({ inReplyTo: null }),
    recipients: ["andreas@try-belline.com"], store, env: BATCH_ENV,
  });
  assert.equal(outcome.matchedBy, "address");
  assert.equal(outcome.leadId, 501);
});

await test("a second message in the same thread attaches to the same lead", async () => {
  const { store, item } = await sent();
  await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-4a", raw: inbound({ inReplyTo: item.rfcMessageId! }),
    recipients: ["andreas@try-belline.com"], store, env: BATCH_ENV,
  });
  const second = [
    "From: Dr Khan <info@jumeirah-dental.test>",
    "To: andreas@try-belline.com",
    "Subject: Re: a 2-minute demo",
    "Message-ID: <second@jumeirah-dental.test>",
    "In-Reply-To: <andreas-human-answer@try-belline.com>",
    `References: <${item.rfcMessageId}> <reply-1@jumeirah-dental.test> <andreas-human-answer@try-belline.com>`,
    "Content-Type: text/plain",
    "",
    "Thursday at 3 then.",
  ].join("\r\n");
  const outcome = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-4b", raw: second,
    recipients: ["andreas@try-belline.com"], store, env: BATCH_ENV,
  });
  assert.equal(outcome.leadId, 501);
  assert.equal(outcome.matchedBy, "thread");
  assert.equal((await store.listReplies({ leadId: 501, limit: 10 })).length, 2);
});

await test("a redelivered notification is one row, one stop, one timeline entry", async () => {
  const { store, item } = await sent();
  const raw = inbound({ inReplyTo: item.rfcMessageId! });
  const first = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-dupe", raw, recipients: [], store, env: BATCH_ENV,
  });
  const second = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-dupe", raw, recipients: [], store, env: BATCH_ENV,
  });
  assert.equal(first.action, "stopped");
  assert.equal(second.action, "duplicate");
  assert.equal((await store.listReplies({ limit: 10 })).length, 1);
});

await test("an unmistakable opt-out suppresses the whole company", async () => {
  const { store, item } = await sent();
  const outcome = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-5",
    raw: inbound({ inReplyTo: item.rfcMessageId!, body: "Please take me off your list." }),
    recipients: [], store, env: BATCH_ENV,
  });
  assert.equal(outcome.action, "suppressed");
  assert.ok(await store.suppressed({ email: "info@jumeirah-dental.test" }));
  assert.ok(await store.suppressed({ companyId: 9001 }), "the company, not only the address");
  assert.equal((await store.getSequence(501))?.stopReason, "unsubscribed");
});

await test("an ambiguous one stops the sequence but suppresses nobody, and is flagged", async () => {
  const { store, item } = await sent();
  const outcome = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-6",
    raw: inbound({ inReplyTo: item.rfcMessageId!, body: "Not interested at the moment." }),
    recipients: [], store, env: BATCH_ENV,
  });
  assert.equal(outcome.action, "flagged");
  assert.equal((await store.getSequence(501))?.status, "stopped", "a reply is still a reply");
  assert.equal(await store.suppressed({ companyId: 9001 }), null, "a guess must not suppress");
  const [row] = await store.listReplies({ needsReview: true, limit: 5 });
  assert.equal(row.optOutConfidence, "likely");
  assert.equal(row.isOptOut, false);
});

await test("a message that matches no lead is recorded and flagged, never dropped", async () => {
  const { store } = await sent();
  const outcome = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-7",
    raw: inbound({ from: "stranger@nowhere.test", inReplyTo: null }),
    recipients: ["andreas@try-belline.com"], store, env: BATCH_ENV,
  });
  assert.equal(outcome.action, "flagged");
  assert.equal(outcome.leadId, null);
  assert.equal(outcome.matchedBy, "none");
  assert.equal((await store.listReplies({ needsReview: true, limit: 5 })).length, 1);
});

// ---------------------------------------------------------------------------
section("An out-of-office pauses and resumes; it never stops");

await test("an out-of-office does not stop the sequence", async () => {
  const { store, item } = await sent();
  const outcome = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-ooo-1",
    raw: inbound({
      inReplyTo: item.rfcMessageId!,
      subject: "Automatic reply: a 2-minute demo",
      body: "I am out of the office and will be back on 2026-10-05.",
    }),
    recipients: [], store, env: BATCH_ENV, now: MONDAY,
  });
  assert.equal(outcome.action, "paused");
  assert.equal(outcome.kind, "auto_reply");
  const state = await store.getSequence(501)!;
  assert.equal(state?.status, "active", "an auto-reply must never stop a sequence");
  assert.equal(state?.stopReason, null);
  assert.equal(state?.pausedUntil?.slice(0, 10), "2026-10-05");
  assert.equal(await store.suppressed({ companyId: 9001 }), null);
});

await test("the step does not move, so nothing is lost by pausing", async () => {
  const { store, item } = await sent();
  const before = await store.getSequence(501);
  await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-ooo-2",
    raw: inbound({ inReplyTo: item.rfcMessageId!, headers: ["Auto-Submitted: auto-replied"], body: "Away." }),
    recipients: [], store, env: BATCH_ENV, now: MONDAY,
  });
  const after = await store.getSequence(501);
  assert.equal(after?.step, before?.step);
});

await test("an out-of-office with no date pauses for a week, not forever", async () => {
  const { store, item } = await sent();
  const outcome = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-ooo-3",
    raw: inbound({ inReplyTo: item.rfcMessageId!, headers: ["Auto-Submitted: auto-replied"], body: "I am away." }),
    recipients: [], store, env: BATCH_ENV, now: MONDAY,
  });
  const days = (Date.parse(outcome.pausedUntil!) - MONDAY.getTime()) / 86_400_000;
  assert.ok(Math.abs(days - receiveMod.DEFAULT_PAUSE_DAYS) < 0.01, `paused for ${days} days`);
});

await test("an auto-reply claiming a date next year is clamped, not believed", async () => {
  const state = sequence.pause(
    sequence.blankState(1, 1, "AE"),
    new Date("2029-01-01T00:00:00Z"),
    "out of office",
    MONDAY,
  );
  const days = (Date.parse(state.pausedUntil!) - MONDAY.getTime()) / 86_400_000;
  assert.equal(Math.round(days), sequence.MAX_PAUSE_DAYS);
});

await test("a follow-up already on today's clock is moved, not cancelled", async () => {
  const { store, item } = await sent();
  const followUp = await queueFollowUp(store, item, "2026-09-25T06:00:00Z");
  await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-ooo-4",
    raw: inbound({
      inReplyTo: item.rfcMessageId!,
      subject: "Out of Office",
      body: "Back on 2026-10-05.",
    }),
    recipients: [], store, env: BATCH_ENV, now: MONDAY,
  });
  const after = await store.getItem(followUp.id);
  assert.equal(after?.status, "queued", "a paused lead's follow-up must survive");
  assert.equal(after?.scheduledFor?.slice(0, 10), "2026-10-05");
});

await test("a paused sequence is not due, and the gate refuses to send into it", async () => {
  const paused = sequence.pause(
    { ...sequence.blankState(1, 1, "AE"), step: 1, nextDueAt: "2026-09-22T06:00:00Z" },
    new Date("2026-10-05T09:00:00Z"),
    "out of office",
    MONDAY,
  );
  assert.deepEqual(sequence.dueNow([paused], new Date("2026-09-23T06:00:00Z")), []);
  const verdict = compliance.screen({
    companyName: "X", toAddress: "a@b.test", countryCode: "AE",
    country: countries.effectiveRule("AE"),
    identity: (await import("../src/lib/legal/identity")).legalIdentity(BATCH_ENV),
    suppressed: null, step: 2, touches90d: 0, lastTouchAt: null, hasDemoLink: true, hasResearch: true,
    sequenceStopped: null, sequencePausedUntil: paused.pausedUntil, guardProblems: [],
    // Everything else about this lead is sendable — including the Art. 13/14
    // privacy notice — so the only thing standing between it and a send is the
    // out-of-office pause, which is what this test is about.
    canSignUnsubscribe: true, hasPrivacyNotice: true, engineReady: true,
    now: new Date("2026-09-23T06:00:00Z"),
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(
    verdict.blocks.map((b) => b.code),
    ["sequence_paused"],
    "the pause must be the only reason this is refused",
  );
});

await test("once the date passes, the sequence is due again all by itself", async () => {
  const paused = sequence.pause(
    { ...sequence.blankState(1, 1, "AE"), step: 1, nextDueAt: "2026-09-22T06:00:00Z" },
    new Date("2026-10-05T09:00:00Z"),
    "out of office",
    MONDAY,
  );
  const after = new Date("2026-10-06T06:00:00Z");
  assert.equal(sequence.isPaused(paused, after), false);
  assert.equal(sequence.dueNow([paused], after).length, 1, "the follow-up must come back by itself");
});

await test("a real reply after an out-of-office stops it for good", async () => {
  const { store, item } = await sent();
  await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-ooo-5",
    raw: inbound({ inReplyTo: item.rfcMessageId!, subject: "Automatic reply", body: "Away until 2026-10-05." }),
    recipients: [], store, env: BATCH_ENV, now: MONDAY,
  });
  await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-ooo-6",
    raw: inbound({ inReplyTo: item.rfcMessageId!, body: "Back now — Thursday works." }),
    recipients: [], store, env: BATCH_ENV, now: new Date("2026-10-06T08:00:00Z"),
  });
  const state = await store.getSequence(501);
  assert.equal(state?.status, "stopped");
  assert.equal(state?.pausedUntil, null, "a stop clears the pause");
});

await test("an auto-reply that reads like an opt-out goes to a person, and still only pauses", async () => {
  // "She no longer works here" is the common case, and it is a person's
  // decision whether that ends the conversation.
  const { store, item } = await sent();
  const outcome = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-ooo-7",
    raw: inbound({
      inReplyTo: item.rfcMessageId!,
      headers: ["Auto-Submitted: auto-replied"],
      body: "Dr Khan no longer works here. I am out of the office.",
    }),
    recipients: [], store, env: BATCH_ENV, now: MONDAY,
  });
  assert.equal(outcome.action, "paused");
  assert.equal(await store.suppressed({ companyId: 9001 }), null);
  const [row] = await store.listReplies({ needsReview: true, limit: 5 });
  assert.equal(row.kind, "auto_reply");
});

// ---------------------------------------------------------------------------
section("Bounces, through the pipeline");

await test("a permanent bounce suppresses the address and stops the sequence", async () => {
  const { store } = await sent();
  const outcome = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-b1", raw: dsn("5.1.1", "failed"),
    recipients: ["andreas@try-belline.com"], store, env: BATCH_ENV,
  });
  assert.equal(outcome.action, "stopped");
  assert.equal((await store.getSequence(501))?.stopReason, "bounced");
  assert.ok(await store.suppressed({ email: "info@jumeirah-dental.test" }));
});

await test("a temporary bounce suppresses nobody and stops nothing", async () => {
  const { store } = await sent();
  const outcome = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-b2", raw: dsn("4.2.2", "delayed"),
    recipients: ["andreas@try-belline.com"], store, env: BATCH_ENV,
  });
  assert.equal(outcome.action, "noted");
  assert.equal((await store.getSequence(501))?.status, "active");
  assert.equal(await store.suppressed({ email: "info@jumeirah-dental.test" }), null);
});

// ---------------------------------------------------------------------------
section("SES's own notification shape");

await test("an SNS-delivered message is unwrapped, base64 or not", () => {
  const raw = "From: a@b.test\r\nSubject: hi\r\n\r\nbody";
  const plain = snsMod.parseSesNotification(
    JSON.stringify({ notificationType: "Received", content: raw, mail: { messageId: "m1" }, receipt: { recipients: ["x@y.test"] } }),
  );
  assert.equal(plain?.raw, raw);
  assert.equal(plain?.sesMessageId, "m1");
  const encoded = snsMod.parseSesNotification(
    JSON.stringify({
      notificationType: "Received",
      content: Buffer.from(raw, "utf8").toString("base64"),
      mail: { messageId: "m2" },
      receipt: { recipients: ["x@y.test"] },
    }),
  );
  assert.equal(encoded?.raw, raw);
});

await test("an S3-stored message gives a pointer rather than content", () => {
  const payload = snsMod.parseSesNotification(
    JSON.stringify({
      notificationType: "Received",
      mail: { messageId: "m3" },
      receipt: { recipients: ["x@y.test"], action: { type: "S3", bucketName: "belline-inbound", objectKey: "inbound/m3" } },
    }),
  );
  assert.equal(payload?.raw, null);
  assert.deepEqual(payload?.s3, { bucket: "belline-inbound", key: "inbound/m3" });
});

await test("SES's spam and virus verdicts come through", () => {
  const payload = snsMod.parseSesNotification(
    JSON.stringify({
      notificationType: "Received",
      mail: { messageId: "m4" },
      receipt: { recipients: [], spamVerdict: { status: "FAIL" }, virusVerdict: { status: "FAIL" } },
    }),
  );
  assert.equal(payload?.spam, true);
  assert.equal(payload?.virus, true);
});

await test("a bounce notification down a configuration-set topic is not a receipt", () => {
  assert.equal(snsMod.parseSesNotification(JSON.stringify({ notificationType: "Bounce", bounce: {} })), null);
  assert.equal(snsMod.parseSesNotification("not json"), null);
});

await test("a message SES marked as spam that answers nothing of ours is dropped", async () => {
  const { store } = await sent();
  const outcome = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-spam", raw: inbound({ from: "spam@nowhere.test", inReplyTo: null }),
    recipients: ["andreas@try-belline.com"], spam: true, store, env: BATCH_ENV,
  });
  assert.equal(outcome.action, "ignored");
  assert.equal((await store.listReplies({ limit: 5 })).length, 0);
});

await test("a message SES marked as spam that does answer ours is kept", async () => {
  // A prospect whose own mail server marks us is still a prospect.
  const { store, item } = await sent();
  const outcome = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-spam-2", raw: inbound({ inReplyTo: item.rfcMessageId! }),
    recipients: [], spam: true, store, env: BATCH_ENV,
  });
  assert.equal(outcome.action, "stopped");
});

await test("a virus is dropped without being parsed", async () => {
  const { store } = await sent();
  const outcome = await receiveMod.receiveInbound({
    provider: "ses", providerMessageId: "ses-virus", raw: "anything at all",
    recipients: [], virus: true, store, env: BATCH_ENV,
  });
  assert.equal(outcome.action, "ignored");
});

// ---------------------------------------------------------------------------
section("Nothing here can reach AWS without explicit credentials");

await test("reading from S3 refuses without credentials, and names them", () => {
  const result = s3Mod.s3Reader({ env: {} });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.missing, [
    "OUTREACH_INBOUND_ACCESS_KEY_ID",
    "OUTREACH_INBOUND_SECRET_ACCESS_KEY",
    "OUTREACH_INBOUND_REGION",
  ]);
  assert.equal("reader" in result, false, "a refusal must never carry a reader");
});

await test("with credentials it signs, and it signs with the fetch it was given", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const result = s3Mod.s3Reader({
    env: {
      OUTREACH_INBOUND_ACCESS_KEY_ID: "AKIAEXAMPLE",
      OUTREACH_INBOUND_SECRET_ACCESS_KEY: "secretexample",
      OUTREACH_INBOUND_REGION: "eu-west-1",
    },
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return new Response("raw message", { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(await result.reader.get("belline-inbound", "inbound/m1"), "raw message");
  assert.equal(calls[0].url, "https://belline-inbound.s3.eu-west-1.amazonaws.com/inbound/m1");
  assert.match(calls[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/eu-west-1\/s3\/aws4_request/);
});

await test("the inbound modules read no environment variable of their own", () => {
  // Every credential decision belongs in `s3Reader`, which is the one door and
  // the one place that can refuse. A `process.env` read anywhere else is how a
  // missing variable becomes an unauthenticated call rather than a refusal.
  for (const file of walk(path.join(ROOT, "src", "lib", "sales", "inbound"), /\.ts$/)) {
    const relative = path.relative(ROOT, file).replaceAll("\\", "/");
    if (relative.endsWith("/s3.ts")) continue;
    const source = code(fs.readFileSync(file, "utf8"));
    // `receive.ts` takes env as an argument and defaults it; that default is
    // the only permitted mention.
    const reads = (source.match(/process\.env/g) ?? []).length;
    const defaults = (source.match(/env\s*\?\?\s*process\.env/g) ?? []).length;
    assert.equal(reads, defaults, `${relative} reads process.env outside a defaulted argument`);
  }
});

await test("the signer is one module, and nothing else rolls its own", () => {
  const files = walk(path.join(ROOT, "src"), /\.tsx?$/);
  const signers = files
    .filter((f) => /AWS4-HMAC-SHA256/.test(code(fs.readFileSync(f, "utf8"))))
    .map((f) => path.relative(ROOT, f).replaceAll("\\", "/"))
    .sort();
  assert.deepEqual(signers, ["src/lib/aws/sigv4.ts"]);
});

await test("the signer reads no environment variable at all", () => {
  assert.equal(/process\.env/.test(code(read("src/lib/aws/sigv4.ts"))), false);
});

await test("the webhook refuses a bad signature with a 403 and answers everything else 200", () => {
  const route = read("src/app/api/sales/inbound/route.ts");
  assert.match(route, /status: 403/);
  assert.match(route, /verifySns/);
  // A 500 would make SNS redeliver, turning one bad message into a queue.
  assert.equal(/status: 500/.test(route), false);
  assert.equal(/requireApiUser|isBellineStaff/.test(route), false, "SNS cannot log in");
});

await test("the webhook never trusts a topic it was not configured with", () => {
  const route = read("src/app/api/sales/inbound/route.ts");
  assert.match(route, /OUTREACH_INBOUND_SNS_TOPIC_ARN/);
  assert.equal(/allowedTopics:\s*\[\s*["'*]/.test(route), false, "no wildcard topic");
});

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
if (failed > 0) process.exitCode = 1;
