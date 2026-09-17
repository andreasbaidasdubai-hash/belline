/**
 * A venue's logo: the one file an owner gives us that we then show to other
 * people, on the chat window and on somebody else's website.
 *
 * What is pinned is what has to hold without anybody watching: the type comes
 * from the bytes, not the name; a renamed program or web page is refused; size
 * and emptiness are refused in words; an SVG with a script, an event handler,
 * a `javascript:` link, a foreignObject, a DOCTYPE or an outside stylesheet
 * never comes out the other side able to do any of it; and what is served
 * carries the headers that keep it an image.
 *
 *   npm run check:logo
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-logo-"));
delete process.env.DATABASE_URL;

const { checkLogo, sanitiseSvg, logoHeaders, logoUrlFor, LOGO_LIMITS } = await import("../src/lib/logo");
const { saveLogo, removeLogo, serveLogo, uploadLogoFromRequest } = await import("../src/lib/logo-store");
const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { getLocation } = await import("../src/lib/store");

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

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR-fixture")]);
const jpg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF-fixture")]);
const webp = () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBPVP8 fixture")]);
const svg = (body: string, attrs = "") => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${body}</svg>`);
const CIRCLE = '<circle cx="5" cy="5" r="4" fill="#2F4A3A"/>';

/** The sanitised SVG as text, or the refusal. */
function clean(input: Buffer): { ok: true; text: string } | { ok: false; message: string } {
  const out = sanitiseSvg(input);
  return out.ok ? { ok: true, text: out.svg } : out;
}

console.log("\n\x1b[1mWhat a logo is, by its bytes\x1b[0m\n");

await test("PNG, JPG and WebP are recognised by their first bytes and kept as they are", () => {
  for (const [bytes, mime] of [[png(), "image/png"], [jpg(), "image/jpeg"], [webp(), "image/webp"]] as const) {
    const out = checkLogo(bytes);
    assert.ok(out.ok, `${mime} refused`);
    assert.equal(out.ok && out.mime, mime);
    assert.ok(out.ok && out.bytes.equals(bytes), "a raster logo was altered");
  }
});

await test("a program renamed logo.png is refused, in words", () => {
  const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200, 0x90)]);
  const out = checkLogo(exe);
  assert.ok(!out.ok);
  assert.match(out.ok ? "" : out.message, /not a PNG, JPG, WebP or SVG/);
});

await test("a web page renamed logo.svg is refused, with or without a DOCTYPE", () => {
  for (const html of ["<!DOCTYPE html><html><body><script>alert(1)</script></body></html>", "<html><svg></svg></html>", "  <body onload=alert(1)>"]) {
    assert.ok(!checkLogo(Buffer.from(html)).ok, `accepted: ${html}`);
  }
});

await test("empty and oversize files are refused before anything else", () => {
  const empty = checkLogo(new Uint8Array(0));
  assert.ok(!empty.ok && /empty/.test(empty.message));
  const big = Buffer.concat([png(), Buffer.alloc(LOGO_LIMITS.maxBytes)]);
  const out = checkLogo(big);
  assert.ok(!out.ok && /512 KB/.test(out.message));
  assert.ok(checkLogo(Buffer.concat([png(), Buffer.alloc(LOGO_LIMITS.maxBytes - png().length)])).ok, "exactly the limit was refused");
});

await test("a truncated WebP header is not a WebP", () => {
  assert.ok(!checkLogo(Buffer.from("RIFF")).ok);
});

console.log("\n\x1b[1mAn SVG comes out unable to do anything but draw\x1b[0m\n");

await test("a clean logo survives, drawn the same", () => {
  const out = clean(svg(`<g fill="none"><path d="M1 1h8v8H1z" stroke="#000"/>${CIRCLE}</g><text x="1" y="9">Marina &amp; Co</text>`));
  assert.ok(out.ok, out.ok ? "" : out.message);
  assert.match(out.ok ? out.text : "", /<path d="M1 1h8v8H1z" stroke="#000"\/>/);
  assert.match(out.ok ? out.text : "", /Marina &amp; Co/);
});

await test("<script> is removed with everything inside it, in any case", () => {
  const out = clean(svg(`${CIRCLE}<script>fetch('//evil')</script><script type="text/ecmascript"><![CDATA[alert(1)]]></script>`));
  // CDATA outside a <style> is refused outright; the plain script is stripped.
  const plain = clean(svg(`${CIRCLE}<script>fetch('//evil')</script>`));
  assert.ok(plain.ok && !/script|evil/i.test(plain.text), plain.ok ? plain.text : plain.message);
  assert.ok(!out.ok || !/script|alert/i.test(out.text));
});

await test("event handlers are removed, whatever their case or spacing", () => {
  const out = clean(svg(`<circle cx="5" cy="5" r="4" onclick="alert(1)" ONMOUSEOVER = 'alert(2)'/>`, ' onload="alert(0)"'));
  assert.ok(out.ok, out.ok ? "" : out.message);
  assert.ok(!/on[a-z]+=|alert/i.test(out.ok ? out.text : ""), out.ok ? out.text : "");
});

await test("javascript: and outside links are removed; a reference inside the file stays", () => {
  const out = clean(
    svg(
      `<defs><path id="p" d="M0 0h1"/></defs><use href="#p"/><use xlink:href="javascript:alert(1)"/>` +
        `<use href="https://evil.example/x.svg#p"/><rect width="1" height="1" fill="url(https://evil.example/a)"/>` +
        `<rect width="2" height="2" fill="url(#p)" style="fill: url(//evil)"/><path d="M0 0" filter="j&#97;vascript:x"/>`,
      ' xmlns:xlink="http://www.w3.org/1999/xlink"',
    ),
  );
  assert.ok(out.ok, out.ok ? "" : out.message);
  const text = out.ok ? out.text : "";
  assert.ok(!/javascript|evil|j&#97;/i.test(text), text);
  assert.match(text, /<use href="#p"\/>/);
  assert.match(text, /fill="url\(#p\)"/);
});

await test("an <a> link wrapped round the logo is removed", () => {
  const out = clean(svg(`${CIRCLE}<a href="javascript:alert(1)"><rect width="1" height="1"/></a>`));
  assert.ok(out.ok && !/<a|javascript/.test(out.text));
});

await test("foreignObject is removed with the HTML inside it", () => {
  const out = clean(svg(`${CIRCLE}<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="//evil"></iframe></div></foreignObject>`));
  assert.ok(out.ok, out.ok ? "" : out.message);
  assert.ok(!/foreignObject|iframe|evil/i.test(out.ok ? out.text : ""));
});

await test("animate and set, which can rewrite an href into a script, are removed", () => {
  const out = clean(svg(`${CIRCLE}<set attributeName="href" to="javascript:alert(1)"/><animate attributeName="href" values="javascript:alert(1)"/>`));
  assert.ok(out.ok && !/set|animate|javascript/.test(out.text));
});

await test("a DOCTYPE or an entity declaration is refused, not parsed", () => {
  const xxe = Buffer.from(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">${CIRCLE}<text>&x;</text></svg>`);
  assert.ok(!checkLogo(xxe).ok);
  assert.ok(!checkLogo(svg(`${CIRCLE}<!DOCTYPE x>`)).ok);
  assert.ok(!checkLogo(svg(`${CIRCLE}<text>&x;</text>`)).ok, "an undeclared entity got through");
});

await test("a stylesheet that loads or imports anything is refused; a plain one is kept", () => {
  assert.ok(!checkLogo(svg(`<style>@import url(//evil.example/a.css);</style>${CIRCLE}`)).ok);
  assert.ok(!checkLogo(svg(`<style>circle{fill:url(https://evil.example/x)}</style>${CIRCLE}`)).ok);
  assert.ok(!checkLogo(svg(`<style>circle{background:u\\72l(//evil)}</style>${CIRCLE}`)).ok, "a CSS escape hid a url()");
  const ok = clean(svg(`<style><![CDATA[.a{fill:#2F4A3A} g > .a{stroke:url(#grad)}]]></style>${CIRCLE}`));
  assert.ok(ok.ok, ok.ok ? "" : ok.message);
});

await test("processing instructions other than the XML declaration are refused", () => {
  assert.ok(!checkLogo(Buffer.from(`<?xml-stylesheet href="//evil.css"?><svg xmlns="http://www.w3.org/2000/svg">${CIRCLE}</svg>`)).ok);
  assert.ok(checkLogo(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- Illustrator -->\n<svg xmlns="http://www.w3.org/2000/svg">${CIRCLE}</svg>`)).ok);
});

await test("editor clutter and embedded pictures are removed; broken or empty markup is refused", () => {
  const inkscape = clean(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:version="1.3">` +
        `<sodipodi:namedview id="n"/><metadata><rdf:RDF/></metadata><image href="data:image/svg+xml;base64,PHN2Zz4="/>${CIRCLE}</svg>`,
    ),
  );
  assert.ok(inkscape.ok, inkscape.ok ? "" : inkscape.message);
  assert.ok(!/inkscape|sodipodi|metadata|image/.test(inkscape.ok ? inkscape.text : ""));
  assert.ok(!checkLogo(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"></svg>`)).ok, "unclosed tag accepted");
  assert.ok(!checkLogo(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><circle r=1/></svg>`)).ok, "unquoted attribute accepted");
  assert.ok(!checkLogo(svg(`<blink>${CIRCLE}</blink>`)).ok, "an unknown element was accepted");
  const empty = checkLogo(svg(`<script>alert(1)</script>`));
  assert.ok(!empty.ok && /nothing in it we can draw/.test(empty.message));
});

await test("the namespace is added when an export left it out, so the logo still renders", () => {
  const out = clean(Buffer.from(`<svg viewBox="0 0 10 10">${CIRCLE}</svg>`));
  assert.ok(out.ok && out.text.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
});

console.log("\n\x1b[1mStored beside the venue, served as an image\x1b[0m\n");

seedIfEmpty();
const signed = await signUp({
  businessName: "Marina Logo Studio",
  email: "owner@logotest.test",
  password: "Correct-Horse-Battery-9",
  vertical: "salon",
  timezone: "Asia/Dubai",
});
assert.ok(signed.ok, "could not create the test account");
const venueId = signed.ok ? signed.location.id : "";

await test("the served headers keep it an image: type, nosniff, a sandboxing CSP, cacheable, usable cross-site", () => {
  const h = logoHeaders("image/svg+xml", 10);
  assert.equal(h["content-type"], "image/svg+xml; charset=utf-8");
  assert.equal(h["x-content-type-options"], "nosniff");
  assert.match(h["content-security-policy"], /default-src 'none'/);
  assert.match(h["content-security-policy"], /sandbox/);
  assert.match(h["cache-control"], /max-age=31536000.*immutable/);
  assert.equal(h["cross-origin-resource-policy"], "cross-origin");
  assert.equal(logoHeaders("image/png", 3)["content-type"], "image/png");
});

await test("an upload through the request handler is stored off the venue row and served with its headers", async () => {
  const form = new FormData();
  form.append("file", new Blob([svg(`${CIRCLE}<script>alert(1)</script>`, ' onload="alert(1)"')]), "logo.svg");
  const res = await uploadLogoFromRequest(new Request("http://x/api/logo", { method: "POST", body: form }), venueId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const venue = getLocation(venueId)!;
  assert.ok(venue.logo, "no logo record on the venue");
  assert.equal(res.body.logoUrl, logoUrlFor(venue));
  assert.match(res.body.logoUrl ?? "", /^\/api\/logo\/lg_[0-9a-f]{24}$/);
  // The bytes are not in the venue row.
  assert.ok(!JSON.stringify(venue).includes("<circle"), "the logo's bytes were written into locations.json");

  const served = serveLogo(venue.logo!.id);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.match(served.headers.get("content-security-policy") ?? "", /sandbox/);
  const body = await served.text();
  assert.ok(body.includes("<circle") && !/script|onload|alert/.test(body), body);
});

await test("a refused upload says why and changes nothing", async () => {
  const before = getLocation(venueId)!.logo;
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("<!DOCTYPE html><h1>hi</h1>")]), "logo.png");
  const res = await uploadLogoFromRequest(new Request("http://x/api/logo", { method: "POST", body: form }), venueId);
  assert.equal(res.status, 422);
  assert.match(res.body.error ?? "", /not a PNG, JPG, WebP or SVG/);
  assert.deepEqual(getLocation(venueId)!.logo, before);
  const none = await uploadLogoFromRequest(new Request("http://x/api/logo", { method: "POST", body: new FormData() }), venueId);
  assert.equal(none.status, 422);
});

await test("a new logo is a new URL, the old one stops being served, and removing it serves nothing", () => {
  const first = getLocation(venueId)!.logo!;
  const second = saveLogo(venueId, { mime: "image/png", bytes: png() }).logo!;
  assert.notEqual(second.id, first.id);
  assert.equal(serveLogo(first.id).status, 404, "a replaced logo is still served");
  const served = serveLogo(second.id);
  assert.equal(served.headers.get("content-type"), "image/png");
  removeLogo(venueId);
  assert.equal(getLocation(venueId)!.logo, undefined);
  assert.equal(logoUrlFor(getLocation(venueId)!), null);
  assert.equal(serveLogo(second.id).status, 404);
});

await test("an id that is not a logo id never reaches the filesystem", () => {
  for (const id of ["../locations", "lg_..%2f..%2fusers", "lg_ZZZ", "", "lg_" + "a".repeat(23)]) {
    assert.equal(serveLogo(id).status, 404, id);
  }
});

await test("the routes are owner-only and the public one serves by the logo's own id", () => {
  const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
  const owner = src("src/app/api/logo/route.ts");
  assert.equal((owner.match(/requireApiUser\(\)/g) ?? []).length, 2, "upload and remove must both require a signed-in user");
  assert.equal((owner.match(/canEditAgent\(auth\.user, location\.id\)/g) ?? []).length, 2);
  const pub = src("src/app/api/logo/[key]/route.ts");
  assert.match(pub, /serveLogo\(key\)/);
  const upload = src("src/components/LogoUpload.tsx");
  assert.match(upload, /role="alert"/);
  assert.match(upload, /alt="Your logo"/);
  assert.match(upload, /Remove logo/);
});

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
