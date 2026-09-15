/**
 * Setting up from a price list or a brochure, as well as a website.
 *
 * No keys and no network: the model is a stub that records what it was sent,
 * and the website reader is a stub that returns fixed text. What is checked is
 * the part that has to hold without anybody watching — the upload is refused
 * in words an owner can act on, a renamed file is caught by its bytes, the
 * documents reach the model as documents, and nothing about them is kept.
 *
 *   npm run check:setup-uploads
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-uploads-"));
delete process.env.ANTHROPIC_API_KEY;
delete process.env.DATABASE_URL;

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp, applyDraft, setupNote } = await import("../src/lib/onboarding");
const { draftFromRequest, UPLOAD_LIMITS } = await import("../src/lib/onboarding/uploads");
const { getLocation } = await import("../src/lib/store");
const { publish, historyFor } = await import("../src/lib/brain");

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
    failed++;
  }
}

seedIfEmpty();

// ---- fixtures -------------------------------------------------------------

/** A marker no real file would contain, so a leak can be searched for. */
const MARKER = `BELLINE-LEAK-${crypto.randomBytes(8).toString("hex")}`;

const pdf = (extra = "") => Buffer.from(`%PDF-1.4\r\n% ${MARKER}${extra}\r\n%%EOF\r\n`, "latin1");
const png = () =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(MARKER)]);
const jpg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(MARKER)]);
const webp = () =>
  Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.from(MARKER)]);

const FOUND = {
  name: "Palm Jumeirah Dental",
  vertical: "clinic" as const,
  address: "Shop 2, The Palm, Dubai",
  timezone: "Asia/Dubai",
  greeting: "Good morning, Palm Jumeirah Dental, how can I help?",
  services: [{ name: "Check-up", durationMin: 30, price: 300 }],
  staff: ["Dr Aisha"],
  faqs: [{ q: "Is there parking?", a: "Yes." }],
};

type Sent = { messages: { role: string; content: unknown }[] } & Record<string, unknown>;

function stubModel() {
  const calls: Sent[] = [];
  const model = async (params: unknown) => {
    calls.push(params as Sent);
    return { content: [{ type: "tool_use", id: "t1", name: "describe_business", input: FOUND }] };
  };
  return { calls, model };
}

const SITE_TEXT = "Palm Jumeirah Dental. Check-up AED 300. ".repeat(10);
const readSite = async (raw: string) => ({
  url: new URL(raw.includes("://") ? raw : `https://${raw}`),
  text: SITE_TEXT,
});

function multipart(opts: { website?: string; files?: { name: string; type: string; bytes: Buffer }[] }) {
  const form = new FormData();
  if (opts.website !== undefined) form.set("website", opts.website);
  for (const f of opts.files ?? []) {
    form.append("files", new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
  }
  return new Request("http://localhost/api/setup", { method: "POST", body: form });
}

function json(body: unknown) {
  return new Request("http://localhost/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Every file under DATA_DIR, with a hash of its contents. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(full, crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
    }
  };
  walk(process.env.DATA_DIR!);
  return out;
}

function anywhereUnderDataDir(needle: string): string[] {
  const hits: string[] = [];
  for (const file of snapshot().keys()) {
    if (file.includes(needle) || fs.readFileSync(file).includes(needle)) hits.push(file);
  }
  return hits;
}

const made = await signUp({
  businessName: "Palm Jumeirah Dental",
  email: "owner@palmdental.test",
  password: "Correct-Horse-Battery-9",
  vertical: "clinic",
  timezone: "Asia/Dubai",
});
assert.ok(made.ok);
const owner = made.ok ? made.user : null!;
const venueId = made.ok ? made.location.id : "";

console.log("\n\x1b[1mRefusing what cannot be read\x1b[0m\n");

await test("the limits are three files of ten megabytes", () => {
  assert.equal(UPLOAD_LIMITS.maxFiles, 3);
  assert.equal(UPLOAD_LIMITS.maxBytes, 10 * 1024 * 1024);
});

await test("more than three files is refused, and the model is never called", async () => {
  const { calls, model } = stubModel();
  const files = [1, 2, 3, 4].map((i) => ({ name: `menu-${i}.pdf`, type: "application/pdf", bytes: pdf() }));
  const out = await draftFromRequest(multipart({ files }), { model, readSite });
  assert.equal(out.status, 422);
  assert.match(String(out.body.error), /up to 3 files/i);
  assert.equal(calls.length, 0);
});

await test("a file over ten megabytes is refused by name", async () => {
  const { calls, model } = stubModel();
  const big = Buffer.concat([pdf(), Buffer.alloc(UPLOAD_LIMITS.maxBytes)]);
  const out = await draftFromRequest(
    multipart({ files: [{ name: "huge-brochure.pdf", type: "application/pdf", bytes: big }] }),
    { model, readSite },
  );
  assert.equal(out.status, 422);
  assert.match(String(out.body.error), /huge-brochure\.pdf.*10 MB/);
  assert.equal(calls.length, 0);
});

await test("a file that is not really a PDF or image is refused, whatever it calls itself", async () => {
  const { calls, model } = stubModel();
  const html = Buffer.from("<html><script>alert(1)</script></html>");
  for (const disguise of [
    { name: "prices.pdf", type: "application/pdf" },
    { name: "menu.png", type: "image/png" },
    { name: "photo.jpg", type: "image/jpeg" },
  ]) {
    const out = await draftFromRequest(multipart({ files: [{ ...disguise, bytes: html }] }), { model, readSite });
    assert.equal(out.status, 422, disguise.name);
    assert.match(String(out.body.error), /PDF, JPG, PNG or WebP/);
  }
  assert.equal(calls.length, 0);
});

await test("an empty file is refused", async () => {
  const { model } = stubModel();
  const out = await draftFromRequest(
    multipart({ files: [{ name: "blank.pdf", type: "application/pdf", bytes: Buffer.alloc(0) }] }),
    { model, readSite },
  );
  assert.equal(out.status, 422);
});

await test("neither a website nor a file asks for one of them", async () => {
  const { model } = stubModel();
  const out = await draftFromRequest(multipart({ website: "  " }), { model, readSite });
  assert.equal(out.status, 422);
  assert.match(String(out.body.error), /website|price list|brochure/i);
});

console.log("\n\x1b[1mReading what can\x1b[0m\n");

await test("a PDF becomes a document block and an image an image block, by their bytes", async () => {
  const { calls, model } = stubModel();
  const out = await draftFromRequest(
    multipart({
      files: [
        // The declared type is wrong on purpose: the bytes decide.
        { name: "price-list.pdf", type: "application/octet-stream", bytes: pdf() },
        { name: "brochure.jpeg", type: "image/png", bytes: jpg() },
        { name: "menu.webp", type: "", bytes: webp() },
      ],
    }),
    { model, readSite },
  );
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(calls.length, 1);
  const content = calls[0].messages[0].content as { type: string; source?: { type: string; media_type: string; data: string } }[];
  assert.ok(Array.isArray(content));
  const docs = content.filter((b) => b.type === "document");
  const images = content.filter((b) => b.type === "image");
  assert.equal(docs.length, 1);
  assert.deepEqual(
    { type: docs[0].source!.type, media_type: docs[0].source!.media_type },
    { type: "base64", media_type: "application/pdf" },
  );
  assert.equal(Buffer.from(docs[0].source!.data, "base64").toString("latin1"), pdf().toString("latin1"));
  assert.deepEqual(images.map((b) => b.source!.media_type).sort(), ["image/jpeg", "image/webp"]);
  assert.equal(calls[0].model, "claude-sonnet-5");
  assert.deepEqual(calls[0].tool_choice, { type: "tool", name: "describe_business" });
});

await test("files alone, with no website, produce a draft the review screen can show", async () => {
  const { model } = stubModel();
  const out = await draftFromRequest(
    multipart({ website: "", files: [{ name: "price-list.pdf", type: "application/pdf", bytes: pdf() }] }),
    { model, readSite: async () => assert.fail("no website was given, so nothing should be fetched") },
  );
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const draft = out.body.draft!;
  assert.equal(draft.found.name, FOUND.name);
  assert.equal(draft.sourceUrl, "");
  assert.equal(draft.documents, 1);
  assert.ok(draft.gaps.some((g) => g.field === "policies"));
});

await test("a website and files are read together, in one call, into one draft", async () => {
  const { calls, model } = stubModel();
  const out = await draftFromRequest(
    multipart({
      website: "palmdental.ae",
      files: [
        { name: "price-list.pdf", type: "application/pdf", bytes: pdf() },
        { name: "brochure.png", type: "image/png", bytes: png() },
      ],
    }),
    { model, readSite },
  );
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(calls.length, 1);
  const content = calls[0].messages[0].content as { type: string; text?: string }[];
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  assert.ok(text.includes(SITE_TEXT.trim()), "the website text is in the message");
  assert.ok(text.includes("https://palmdental.ae/"));
  assert.equal(content.filter((b) => b.type === "document").length, 1);
  assert.equal(content.filter((b) => b.type === "image").length, 1);
  // File names are the owner's business, not the model's.
  assert.ok(!JSON.stringify(calls[0]).includes("price-list.pdf"));
  assert.equal(out.body.draft!.sourceUrl, "https://palmdental.ae/");
  assert.equal(out.body.draft!.documents, 2);
});

await test("the JSON body still works, as before", async () => {
  const { calls, model } = stubModel();
  const out = await draftFromRequest(json({ website: "palmdental.ae" }), { model, readSite });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.draft!.sourceUrl, "https://palmdental.ae/");
  assert.equal(typeof calls[0].messages[0].content === "string" || Array.isArray(calls[0].messages[0].content), true);
  const missing = await draftFromRequest(json({}), { model, readSite });
  assert.equal(missing.status, 422);
  const broken = await draftFromRequest(
    new Request("http://localhost/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }),
    { model, readSite },
  );
  assert.equal(broken.status, 400);
});

await test("a model that cannot read the documents is a sentence, not a crash", async () => {
  const out = await draftFromRequest(
    multipart({ files: [{ name: "price-list.pdf", type: "application/pdf", bytes: pdf() }] }),
    { model: async () => ({ content: [] }), readSite },
  );
  assert.equal(out.status, 422);
  assert.ok(String(out.body.error).length > 10);
  assert.ok(out.body.fallback);
});

console.log("\n\x1b[1mKeeping nothing\x1b[0m\n");

await test("reading documents writes nothing, and neither their bytes nor their names are kept anywhere", async () => {
  const before = snapshot();
  const { model } = stubModel();
  const name = `secret-prices-${MARKER}.pdf`;
  const out = await draftFromRequest(
    multipart({ website: "palmdental.ae", files: [{ name, type: "application/pdf", bytes: pdf() }] }),
    { model, readSite },
  );
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual([...snapshot().entries()].sort(), [...before.entries()].sort(), "DATA_DIR changed before save");
  assert.deepEqual(getLocation(venueId)!.salon!.services, [], "the venue changed before save");

  // Now the owner presses save, exactly as PUT does it.
  const draft = out.body.draft!;
  const updated = applyDraft(getLocation(venueId)!, { name: draft.found.name, services: draft.found.services });
  publish(updated.id, owner, setupNote(draft.sourceUrl, draft.documents));
  assert.equal(getLocation(venueId)!.salon!.services.length, 1);
  assert.deepEqual(anywhereUnderDataDir(MARKER), [], "a file's bytes or name reached DATA_DIR");
  assert.deepEqual(anywhereUnderDataDir("secret-prices"), []);
});

await test("the published version says where the setup came from", () => {
  assert.equal(setupNote("https://example.ae/", 2), "Set up from example.ae and 2 documents");
  assert.equal(setupNote("https://example.ae/", 1), "Set up from example.ae and 1 document");
  assert.equal(setupNote("https://www.example.ae/services", 0), "Set up from www.example.ae");
  assert.equal(setupNote("", 3), "Set up from 3 documents");
  assert.equal(setupNote("", 0), "Set up by hand");
  assert.match(historyFor(getLocation(venueId)!)[0].note, /^Set up from palmdental\.ae and 1 document$/);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0 ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n` : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;
