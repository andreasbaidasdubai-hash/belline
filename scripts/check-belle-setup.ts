/**
 * Belle, the setup assistant, with a scripted model.
 *
 * She reads where the owner is, explains forwarding for their carrier, uses
 * the new write tools through the same validation as the setup pages, and
 * hands over to a person only when she is allowed to: never for something
 * the owner can do, and "I want a person" only the second time. With no model
 * the owner still gets the next step and its help, with nothing internal in it.
 *
 * No keys, no network, no database.
 *
 *   npm run check:belle-setup
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-belle-setup-"));
for (const k of Object.keys(process.env)) if (k.startsWith("FLAG_") || /^(ANTHROPIC|RESEND)_/.test(k)) delete process.env[k];

const realFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = (async () => {
  fetches++;
  throw new Error("network is off in check:belle-setup");
}) as typeof fetch;

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { getLocation, upsertLocation } = await import("../src/lib/store");
const { SETUP_TOOLS, executeSetupTool, runSetupTool, runSetupTurn, exceptionAllowed, helpCard, humanAsks, setupGreeting } = await import(
  "../src/lib/onboarding/assistant"
);
const { listExceptions } = await import("../src/lib/exceptions");
const { HELP_ARTICLES, articleFor } = await import("../src/lib/onboarding/help");
const { looksInternal } = await import("../src/lib/errors/customer");
const { fakeModel, toolReply } = await import("../src/lib/testing/stubs");

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

const ROOT = path.resolve(import.meta.dirname, "..");
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
async function quiet<T>(fn: () => Promise<T> | T): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

type Params = { messages: { role: string; content: unknown }[] };
/** The text of the last tool result the model was sent. */
function lastToolResult(params: Params): string {
  const last = params.messages.at(-1);
  return Array.isArray(last?.content) ? (last.content as { content?: string }[]).map((c) => c.content ?? "").join("\n") : "";
}
const text = (t: string) => ({ content: [{ type: "text", text: t }] });

seedIfEmpty();
async function venue(name: string) {
  const made = await signUp({ businessName: name, email: `owner@${name.toLowerCase().replace(/\W+/g, "")}.test`, password: "Correct-Horse-Battery-9", vertical: "salon" });
  assert.ok(made.ok);
  return { id: made.ok ? made.location.id : "", by: { id: made.ok ? made.user.id : "", name: "Owner" } };
}
const salon = await venue("Belle Setup Salon");
const exceptionsFor = (id: string) => listExceptions({ locationId: id, status: "all" });

console.log("\n\x1b[1mUnblocking with a scripted model\x1b[0m\n");

await test("'my forwarding didn't work, I'm on e& landline' calls explain_forwarding, replies with the 101 script, opens nothing", async () => {
  const model = fakeModel([
    toolReply("explain_forwarding", { carrier: "eand", line: "landline" }),
    (params) => text(`Here is what to do: ${lastToolResult(params as Params)}`),
  ]);
  const out = await quiet(() =>
    runSetupTurn(salon.id, salon.by, [{ role: "user", content: "my forwarding didn't work, I'm on e& landline" }], { model: model.call }),
  );
  assert.equal(model.calls.length, 2);
  assert.match(out.reply, /\b101\b/);
  assert.equal(out.ticket, undefined);
  assert.equal(exceptionsFor(salon.id).length, 0);
});

await test("the system prompt carries the journey: current step and what blocks Go live", async () => {
  const model = fakeModel([text("Hello")]);
  await quiet(() => runSetupTurn(salon.id, salon.by, [{ role: "user", content: "Where am I?" }], { model: model.call }));
  const system = String((model.calls[0] as { system?: unknown }).system);
  assert.match(system, /Current step: \d+ of 9/);
  assert.match(system, /Blocking Go live:/);
});

await test("'I want a human' once gets help, and the model cannot open a ticket for it", async () => {
  const model = fakeModel([
    toolReply("open_exception", { kind: "owner_requested_human", reason: "wants a person" }),
    (params) => {
      assert.match(lastToolResult(params as Params), /Not opened/);
      return text("Happy to help. What are you stuck on? If you still want a person, ask again.");
    },
  ]);
  const out = await quiet(() => runSetupTurn(salon.id, salon.by, [{ role: "user", content: "I want a human" }], { model: model.call }));
  assert.equal(out.ticket, undefined);
  assert.equal(exceptionsFor(salon.id).length, 0);
  assert.match(String((model.calls[0] as { system?: unknown }).system), /asked for a person, once/);
});

await test("'I want a human' twice opens owner_requested_human with the excerpt, and says the ticket number", async () => {
  const model = fakeModel([]);
  const history = [
    { role: "user" as const, content: "I want a human" },
    { role: "assistant" as const, content: "Happy to help. What are you stuck on?" },
    { role: "user" as const, content: "No, I want a human please" },
  ];
  assert.equal(humanAsks(history), 2);
  const out = await quiet(() => runSetupTurn(salon.id, salon.by, history, { model: model.call }));
  assert.equal(model.calls.length, 0, "the second request does not wait on the model");
  const rows = exceptionsFor(salon.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "owner_requested_human");
  assert.equal(rows[0].source, "belle");
  assert.match(String(rows[0].context.excerpt), /I want a human/);
  assert.ok(out.ticket && out.reply.includes(out.ticket), out.reply);
  // Asking a third time counts on the same ticket rather than opening another.
  await quiet(() => runSetupTurn(salon.id, salon.by, [...history, { role: "user", content: "a real person" }], { model: model.call }));
  assert.equal(exceptionsFor(salon.id).length, 1);
  assert.equal(exceptionsFor(salon.id)[0].count, 2);
});

await test("Belle cannot open a ticket for something self-serve ('forgot where the snippet goes')", async () => {
  const other = await venue("Snippet Studio");
  const model = fakeModel([
    toolReply("open_exception", { kind: "website_snippet", reason: "forgot where the snippet goes" }),
    toolReply("open_exception", { kind: "import_failed_3x", reason: "forgot where the snippet goes" }),
    (params) => {
      assert.match(lastToolResult(params as Params), /can do themselves/);
      return text("It goes before the closing body tag.");
    },
  ]);
  const out = await quiet(() => runSetupTurn(other.id, other.by, [{ role: "user", content: "I forgot where the snippet goes" }], { model: model.call }));
  assert.equal(out.ticket, undefined);
  assert.equal(exceptionsFor(other.id).length, 0);
});

console.log("\n\x1b[1mThe guard, as a table\x1b[0m\n");

await test("allowed kinds follow the venue's state", () => {
  const loc = getLocation(salon.id)!;
  const none = { ...loc, bellineNumber: undefined };
  // A Belline number is its own field, set only when Belline assigns one.
  const has = { ...loc, bellineNumber: { number: "+97145550000", via: "staff" as const, assignedAt: "2026-09-16T08:00:00.000Z" } };
  const once = [{ role: "user" as const, content: "can I talk to someone" }];
  const cases: [unknown, typeof loc, typeof once, boolean][] = [
    ["pool_empty", none, [], true],
    ["pool_empty", has, [], false],
    ["number_assign_failed", has, [], false],
    ["forwarding_unverified_2x", has, [], true],
    ["forwarding_unverified_2x", none, [], false],
    ["whatsapp_rejected", has, [], true],
    ["billing_dispute", has, [], true],
    ["owner_requested_human", has, once, false],
    ["owner_requested_human", has, [...once, { role: "user", content: "a real person please" }], true],
    ["import_failed_3x", has, [], false],
    ["account_recovery", has, [], false],
    ["vendor_balance_low", has, [], false],
    ["help_with_website", has, [], false],
    [undefined, has, [], false],
  ];
  for (const [kind, v, history, expected] of cases) assert.equal(exceptionAllowed(kind, v, history).ok, expected, `${String(kind)} bellineNumber=${v.bellineNumber?.number}`);
});

console.log("\n\x1b[1mNo model switched on\x1b[0m\n");

await test("the fallback gives the next step, its button and its article, with nothing internal", async () => {
  const out = await quiet(() => runSetupTurn(salon.id, salon.by, [{ role: "user", content: "Hello" }]));
  assert.match(out.reply, /not switched on/);
  assert.ok(!looksInternal(out.reply), out.reply);
  assert.ok(!/API_KEY|ANTHROPIC|FLAG_|env/i.test(out.reply), out.reply);
  assert.ok(out.help, "no help card");
  assert.ok(out.help!.fix.startsWith("/"), out.help!.fix);
  assert.ok(out.help!.article?.body, "no article");
});

await test("with a step given, the card is for that step", () => {
  const card = helpCard(getLocation(salon.id)!, undefined, "channels");
  assert.match(card.title, /Phone and website/);
  assert.ok(card.article && /forward|chat|number/i.test(card.article.body));
  assert.match(setupGreeting(getLocation(salon.id)!, "channels"), /Phone and website/);
});

await test("without a model, asking for a person once says to ask again; twice opens the ticket", async () => {
  const other = await venue("Fallback Florist");
  const once = await quiet(() => runSetupTurn(other.id, other.by, [{ role: "user", content: "I want a human" }], { model: null }));
  assert.match(once.reply, /say so again/);
  assert.equal(exceptionsFor(other.id).length, 0);
  const twice = await quiet(() =>
    runSetupTurn(other.id, other.by, [
      { role: "user", content: "I want a human" },
      { role: "assistant", content: once.reply },
      { role: "user", content: "I want a human" },
    ], { model: null }),
  );
  assert.ok(twice.ticket);
  assert.equal(exceptionsFor(other.id).length, 1);
});

await test("help articles: 15 to 25, written for owners, with nothing internal", () => {
  assert.ok(HELP_ARTICLES.length >= 15 && HELP_ARTICLES.length <= 25, String(HELP_ARTICLES.length));
  for (const a of HELP_ARTICLES) {
    assert.ok(!looksInternal(a.body) && !a.body.includes("hello@"), a.id);
    assert.ok(!/\b(works with|connects to) (Google|Outlook)/i.test(a.body), `${a.id} claims a calendar`);
  }
  assert.equal(articleFor("where does the snippet go")?.id, "website-snippet");
  assert.equal(articleFor("e& landline")?.id, "forwarding-landline");
});

console.log("\n\x1b[1mTools\x1b[0m\n");

await test("every tool from the plan is offered", () => {
  const names = SETUP_TOOLS.map((t) => t.name);
  for (const n of ["get_journey", "explain_forwarding", "check_widget_install", "help_article", "set_destination", "set_booking_link", "set_escalation", "edit_service", "remove_staff", "edit_faq", "open_exception"]) {
    assert.ok(names.includes(n), n);
  }
});

await test("explain_forwarding: mobile codes, the PBX note, and no unverified Virgin codes", () => {
  const s = getLocation(salon.id)!;
  upsertLocation({ ...s, bellineNumber: { number: "+97145550000", via: "pool", assignedAt: "2026-09-16T08:00:00.000Z" } });
  const mobile = executeSetupTool(salon.id, salon.by, "explain_forwarding", { carrier: "du", line: "mobile" });
  assert.match(mobile.say, /\*\*61\*\+97145550000#/);
  assert.match(executeSetupTool(salon.id, salon.by, "explain_forwarding", { carrier: "du", line: "landline" }).say, /\b155\b/);
  assert.match(executeSetupTool(salon.id, salon.by, "explain_forwarding", { line: "pbx" }).say, /phone system/);
  const virgin = executeSetupTool(salon.id, salon.by, "explain_forwarding", { carrier: "virgin", line: "mobile" });
  assert.ok(!virgin.say.includes("**61"), virgin.say);
  upsertLocation({ ...getLocation(salon.id)!, bellineNumber: undefined });
  assert.match(executeSetupTool(salon.id, salon.by, "explain_forwarding", { carrier: "eand", line: "mobile" }).say, /being prepared/);
});

await test("get_journey names the steps and the next one", () => {
  const out = executeSetupTool(salon.id, salon.by, "get_journey", {});
  assert.match(out.say, /1\. Your business \(done\)/);
  assert.match(out.say, /They are on:/);
});

await test("set_destination and set_booking_link go through the journey's own checks", () => {
  assert.equal(executeSetupTool(salon.id, salon.by, "set_booking_link", { url: "https://book.example.com" }).ok, false, "no requests destination yet");
  assert.equal(executeSetupTool(salon.id, salon.by, "set_destination", { destination: "google" }).ok, false);
  assert.ok(executeSetupTool(salon.id, salon.by, "set_destination", { destination: "requests" }).ok);
  assert.equal(getLocation(salon.id)!.onboarding?.destination?.kind, "requests");
  assert.equal(executeSetupTool(salon.id, salon.by, "set_booking_link", { url: "not a link at all" }).ok, false);
  assert.ok(executeSetupTool(salon.id, salon.by, "set_booking_link", { url: "book.example.com/salon" }).ok);
  assert.equal(getLocation(salon.id)!.onboarding?.destination?.bookingLink, "https://book.example.com/salon");
});

await test("set_escalation validates the country, saves E.164, and does not confirm the rules step", () => {
  const refused = executeSetupTool(salon.id, salon.by, "set_escalation", { transfer_number: "+44 20 7946 0000" });
  assert.equal(refused.ok, false);
  const ok = executeSetupTool(salon.id, salon.by, "set_escalation", { transfer_number: "+971 50 123 4567", notify: "desk@salon.test" });
  assert.ok(ok.ok, ok.say);
  const loc = getLocation(salon.id)!;
  assert.equal(loc.agent.transferNumber, "+971501234567");
  assert.equal(loc.onboarding?.escalation?.notifyEmail, "desk@salon.test");
  assert.equal(loc.onboarding?.rulesConfirmedAt, undefined);
});

await test("edit_service, remove_staff and edit_faq change only what was named", () => {
  assert.ok(executeSetupTool(salon.id, salon.by, "add_service", { name: "Cut", duration_min: 45, price: 150 }).ok);
  assert.ok(executeSetupTool(salon.id, salon.by, "add_staff", { name: "Layla" }).ok);
  assert.ok(executeSetupTool(salon.id, salon.by, "add_staff", { name: "Mona" }).ok);
  const edited = executeSetupTool(salon.id, salon.by, "edit_service", { name: "cut", price: 180 });
  assert.ok(edited.ok, edited.say);
  const cut = getLocation(salon.id)!.salon!.services.find((s) => s.name === "Cut")!;
  assert.equal(cut.price, 180);
  assert.equal(cut.durationMin, 45);
  assert.equal(executeSetupTool(salon.id, salon.by, "edit_service", { name: "Perm", price: 1 }).ok, false);
  assert.ok(executeSetupTool(salon.id, salon.by, "remove_staff", { name: "Mona" }).ok);
  assert.deepEqual(getLocation(salon.id)!.salon!.staff.map((s) => s.name).filter((n) => n === "Layla" || n === "Mona"), ["Layla"]);
  assert.ok(executeSetupTool(salon.id, salon.by, "add_faq", { question: "Is there parking?", answer: "Yes." }).ok);
  assert.ok(executeSetupTool(salon.id, salon.by, "edit_faq", { question: "parking", answer: "Yes, free behind the building." }).ok);
  assert.equal(getLocation(salon.id)!.agent.faqs.find((f) => f.q === "Is there parking?")?.a, "Yes, free behind the building.");
  assert.ok(executeSetupTool(salon.id, salon.by, "edit_faq", { question: "Is there parking?", remove: true }).ok);
  assert.ok(!getLocation(salon.id)!.agent.faqs.some((f) => f.q === "Is there parking?"));
});

await test("help_article and check_widget_install answer without reaching the network", async () => {
  assert.match(executeSetupTool(salon.id, salon.by, "help_article", { topic: "snippet" }).say, /closing body tag/);
  const install = await quiet(() => runSetupTool(salon.id, salon.by, "check_widget_install", { url: "http://127.0.0.1/" }));
  assert.equal(install.ok, false);
  assert.equal(fetches, 0);
});

console.log("\n\x1b[1mOn the setup pages\x1b[0m\n");

await test("every setup step opens Belle on that step, and the chat sends it", () => {
  const step = source("src/app/setup/[step]/page.tsx");
  // The bell is given the step, and below 1024px opens Belle's page on it.
  assert.match(step, /<BelleDock[^>]*step=\{step\.id\}/);
  assert.match(source("src/app/setup/BelleDock.tsx"), /`\/setup\/assistant\?step=\$\{step\}`/);
  assert.match(step, /\/setup\/assistant\?step=\$\{blocker\.step\}/);
  const chat = source("src/app/setup/assistant/SetupAssistant.tsx");
  assert.match(chat, /JSON\.stringify\(\{ locationId, step,/);
  assert.match(chat, /line\.help/);
  assert.match(chat, /Ticket \{line\.ticket\}/);
  assert.match(source("src/app/api/setup/assistant/route.ts"), /isStepId\(body\.step\)/);
});

await test("Belle docks beside the step, on every step, around the step's own column", () => {
  const page = source("src/app/setup/[step]/page.tsx");
  // In the shell rather than a branch of Body(): every step gets the toggle,
  // and the step keeps its own column inside the dock, so its Continue /
  // Save / Go live button stays exactly where it was.
  const shell = page.indexOf("export default async function SetupStepPage");
  assert.ok(shell > 0);
  assert.ok(page.indexOf("<BelleDock") > shell, "the dock is inside a step's body, not the shell");
  assert.equal(page.split("<BelleDock").length, 2, "more than one dock");
  assert.match(page, /<BelleDock[^>]*>\s*<div className="setup-grid"/);
  // Docked, she is given the step she is beside, and its greeting.
  assert.match(page, /step=\{step\.id\}/);
  assert.match(page, /greeting=\{setupGreeting\(venue, step\.id\)\}/);
});

await test("the panel is a labelled region, closed by Escape, remembered, and never a phone's", () => {
  const dock = source("src/app/setup/BelleDock.tsx");
  assert.match(dock, /min-width: 1024px/);
  // Below the breakpoint nothing is docked at all: the panel is behind `wide`.
  assert.match(dock, /const docked = wide && open/);
  assert.match(dock, /\{docked && \(/);
  assert.match(dock, /aria-labelledby="belle-dock-title"/);
  assert.match(dock, /e\.key !== "Escape"/);
  assert.match(dock, /panelRef\.current\?\.focus\(\)/, "focus does not move into the panel");
  assert.match(dock, /toggleRef\.current\?\.focus\(\)/, "focus does not come back to the toggle");
  // Storage that throws must not stop the panel opening.
  assert.match(dock, /window\.localStorage\.setItem\(storageKey[^}]*\}\s*catch/);
  assert.match(dock, /window\.localStorage\.getItem\(storageKey\);\s*\}\s*catch/);
  // One Belle: the docked chat is the assistant page's own component.
  assert.match(dock, /import \{ BelleChat \} from "\.\/assistant\/SetupAssistant"/);
  const css = source("src/app/globals.css");
  // In the flow beside the step, never over it, so nothing on the step is covered.
  assert.match(css, /\.setup-dock-panel \{[^}]*position: sticky/);
  assert.doesNotMatch(css, /\.setup-dock-panel \{[^}]*position: fixed/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.setup-dock-panel \{ animation: none/);
});

await test("/setup/assistant still stands on its own, and the narrow way in points at it", () => {
  const page = source("src/app/setup/assistant/page.tsx");
  assert.match(page, /export default async function SetupAssistantPage/);
  assert.match(page, /<SetupAssistant\b/);
  // Below 1024px the bell opens the full page instead of docking.
  const dock = source("src/app/setup/BelleDock.tsx");
  assert.match(dock, /wide \? set\(true, "panel"\) : router\.push\(fullPage\)/);
});

await test("the floating bell is the one way to Belle, on the setup steps and the dashboard", () => {
  const dock = source("src/app/setup/BelleDock.tsx");
  const step = source("src/app/setup/[step]/page.tsx");
  const shell = source("src/app/(app)/layout.tsx");
  const css = source("src/app/globals.css");
  // A real button, named "Ask Belle" by its own text, which stays for screen readers when only the bell shows.
  assert.match(dock, /<button\s+ref=\{toggleRef\}\s+type="button"\s+className="belle-fab"/);
  assert.match(dock, /<span className="belle-fab-say">Ask Belle<\/span>/);
  assert.match(dock, /<svg[^>]*aria-hidden="true"/);
  assert.match(css, /\.belle-fab-say \{ position: absolute; width: 1px;/);
  // Bottom right, the website's bell in look, with a visible focus ring, and still for reduced motion.
  assert.match(css, /\.belle-fab \{[^}]*position: fixed;[^}]*right: 24px;[^}]*bottom: 24px;[^}]*background: var\(--bl-blue\)/);
  assert.match(css, /\.belle-fab:focus-visible \{ outline: 3px solid/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.belle-fab, \.belle-fab svg, \.belle-fab::after \{ animation: none; transition: none; \}/);
  // It never covers a page's own buttons: room is left below and beside the sticky bars.
  assert.match(css, /\.has-belle-fab \.content \{ padding-bottom: 112px; \}/);
  assert.match(css, /\.fab-clear \{ padding-right: 80px; \}/);
  assert.match(source("src/app/setup/SetupWizard.tsx"), /className="fab-clear"/);
  // On the setup shell and the dashboard shell, and nowhere as a second way in.
  assert.match(step, /<BelleDock\b/);
  assert.match(step, /className="has-belle-fab"/);
  assert.doesNotMatch(step, /setup-ask-narrow/);
  assert.match(shell, /<BelleDock locationId=\{belleVenue\.id\}/);
  assert.match(shell, /has-belle-fab/);
  assert.doesNotMatch(shell, /label: "Belle"/, "Belle is still an item in the sidebar");
  assert.doesNotMatch(css, /setup-ask-narrow|setup-dock-tab/);
  // Only for somebody who may change the venue she would change.
  assert.match(shell, /canEditAgent\(user, l\.id\)/);
});

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
