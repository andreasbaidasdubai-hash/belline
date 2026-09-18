/**
 * The staff console (CRM): who may use it, what it changes, and that every
 * change is written down.
 *
 *   staff only on every new page and route
 *   one lead list over the JSON and Postgres stores, and the stage mapping
 *   stage changes persist to the record they came from
 *   owner, next step, notes, the timeline hook, and their audit rows
 *   an edited draft is checked by the pre-send guards again
 *   customer actions: trial extension, plan change, suspend and reactivate,
 *     cancel, reset link, confirm email, disable a user, each audited
 *   view as customer is read-only, enforced before Next and in the stores
 *   old addresses redirect, the menu is the approved one, no jargon
 *
 * A fresh data directory, no database (the Postgres side is a fake port), the
 * network off, no email.
 *
 *   npm run check:staff-crm
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-staff-crm-"));
for (const k of Object.keys(process.env)) {
  if (k.startsWith("FLAG_") || ["RESEND_API_KEY", "DATABASE_URL", "STRIPE_SECRET_KEY", "ANTHROPIC_API_KEY"].includes(k)) delete process.env[k];
}
process.env.FLAG_STUBS = "on";

globalThis.fetch = (async () => {
  throw new Error("network is off in check:staff-crm");
}) as typeof fetch;

const { seedIfEmpty } = await import("../src/lib/seed");
const store = await import("../src/lib/store");
const { createUser, login, peekResetToken, isBellineStaff } = await import("../src/lib/auth");
const { BELLINE_TENANT_ID } = await import("../src/lib/tenancy");
const { signUp } = await import("../src/lib/onboarding");
const stages = await import("../src/lib/staff/stages");
const leads = await import("../src/lib/staff/leads");
const customers = await import("../src/lib/staff/customers");
const viewAs = await import("../src/lib/staff/view-as");
const readonly = await import("../src/lib/staff/readonly");
const { applyDraftEdit, cleanParts, flagsOf, saveDraftEdit, decideDraft, markDraftSent } = await import("../src/lib/staff/drafts");
const { checkDraft } = await import("../src/lib/sales/outreach/guards");
const db = await import("../src/lib/db/client");
const { sellable } = await import("../src/lib/billing/plans");
const { addDays, todayIn } = await import("../src/lib/time");
type Lead = import("../src/lib/leads").Lead;
type User = import("../src/lib/types").User;

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message.replace(/\s+/g, " ") : String(err)}`);
    failed++;
  }
}

const ROOT = path.resolve(import.meta.dirname, "..");
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
/** Comments explain the defects and quote the words being banned. */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const PASSWORD = "Correct-Horse-Battery-9";
const auditFor = (entityId: string) => store.listStaffAuditRows().filter((r) => r.entityId === entityId);

seedIfEmpty();

const staffOut = createUser({ email: "staff@belline.test", name: "Sam Staff", password: PASSWORD, role: "owner", tenantId: BELLINE_TENANT_ID });
assert.ok(staffOut.ok);
const staff = staffOut.user;
const second = createUser({ email: "second@belline.test", name: "Rae Staff", password: PASSWORD, role: "owner", tenantId: BELLINE_TENANT_ID });
assert.ok(second.ok);

const customer = await signUp({ businessName: "Marina Smiles", email: "owner@marina-smiles.test", password: PASSWORD, vertical: "clinic" });
assert.ok(customer.ok, customer.ok ? "" : customer.error);
const owner = (customer as { user: User }).user;
const tenantId = owner.tenantId;
const locationId = (customer as { location: { id: string } }).location.id;
const teammate = createUser({ email: "front@marina-smiles.test", name: "Front Desk", password: PASSWORD, role: "manager", tenantId });
assert.ok(teammate.ok);

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mStaff only\x1b[0m\n");

await test("the staff member passes isBellineStaff and the customer owner does not", () => {
  assert.equal(isBellineStaff(staff), true);
  assert.equal(isBellineStaff(owner), false);
});

const NEW_DOORS = [
  "src/app/(internal)/layout.tsx",
  "src/app/(internal)/sales/page.tsx",
  "src/app/(internal)/sales/leads/page.tsx",
  "src/app/(internal)/sales/leads/[id]/page.tsx",
  "src/app/(internal)/sales/customers/page.tsx",
  "src/app/(internal)/sales/customers/[tenantId]/page.tsx",
  "src/app/(internal)/sales/issues/page.tsx",
  "src/app/(internal)/sales/revenue/page.tsx",
  "src/app/(internal)/sales/settings/page.tsx",
  "src/app/(internal)/sales/settings/activity/page.tsx",
  "src/app/(internal)/sales/settings/agents/[id]/page.tsx",
  "src/app/(internal)/sales/settings/video/page.tsx",
  "src/app/(internal)/sales/settings/demo-lines/page.tsx",
  "src/app/(internal)/sales/settings/numbers/page.tsx",
];
const NEW_ROUTES = ["src/app/api/sales/leads/route.ts", "src/app/api/sales/drafts/route.ts", "src/app/api/sales/customers/route.ts", "src/app/api/sales/customers/view-as/route.ts"];

await test("every new page refuses anybody who is not Belline staff", () => {
  for (const f of NEW_DOORS) assert.match(code(source(f)), /if \(!isBellineStaff\(user\)\)/, f);
});

await test("every new route answers 401 without a session and 403 to a customer, before reading the body", () => {
  for (const f of NEW_ROUTES) {
    const text = code(source(f));
    const guard = text.indexOf("if (!isBellineStaff(auth.user)) return NextResponse.json(");
    assert.ok(guard > 0, `${f}: no staff refusal`);
    assert.match(text.slice(guard, guard + 200), /status: 403/, f);
    assert.ok(text.indexOf("requireApiUser()") < guard, `${f}: the session is not checked first`);
    assert.ok(text.indexOf("request.json()") > guard, `${f}: the body is read before the staff check`);
  }
});

await test("the customer actions refuse a customer and Belline's own tenant, even when called directly", async () => {
  const asCustomer = await customers.extendTrial(owner, tenantId, locationId, 7, "trying it");
  assert.equal(asCustomer.ok, false);
  assert.equal((asCustomer as { status: number }).status, 403);
  const internal = await customers.updateBusinessDetails(staff, BELLINE_TENANT_ID, { name: "Hijacked" });
  assert.equal((internal as { status: number }).status, 404);
  assert.equal(store.getTenant(BELLINE_TENANT_ID)!.name, "Belline");
});

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mOne lead list over both stores\x1b[0m\n");

function jsonLead(id: string, over: Partial<Lead>): Lead {
  return {
    id,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    name: "Person",
    email: `${id}@example.test`,
    phone: "+971501234567",
    phoneValid: true,
    company: `Company ${id}`,
    source: "website",
    emailCheck: { valid: true, email: `${id}@example.test`, mx: true, role: false } as Lead["emailCheck"],
    status: "new",
    ...over,
  };
}

store.saveLead(jsonLead("lead_enquiry", { source: "landing-form" }));
store.saveLead(jsonLead("lead_wa", { source: "belle:whatsapp", status: "booked" }));
store.saveLead(jsonLead("lead_dach", { source: "dach-waitlist", market: "CH", phone: "", status: "closed" }));
store.saveLead(jsonLead("lead_chat", { source: "belle:chat" }));

interface FakeRow {
  stage: string;
}
function fakePort(rows: Record<number, FakeRow> | null) {
  const calls: { id: number; dbStage: string; reason: string | null }[] = [];
  const port: import("../src/lib/staff/leads").LeadDbPort = {
    async list() {
      if (!rows) return null;
      return Object.entries(rows).map(([id, r]) => ({
        id: Number(id),
        company_id: Number(id) * 10,
        name: `Clinic ${id}`,
        email: null,
        phone_e164: null,
        website: `https://clinic${id}.test`,
        country_code: "AE",
        city: "Dubai",
        stage: r.stage,
        current_score: Number(id) === 1 ? 88 : 40,
        priority: Number(id) === 1 ? "hot" : "low",
        created_at: new Date(Date.now() - 86_400_000),
        updated_at: new Date(),
        last_activity_at: null,
        drafts: Number(id) === 2 ? 1 : 0,
        summary: "A busy practice.",
      }));
    },
    async stageOf(id) {
      return rows?.[id]?.stage;
    },
    async setStage(id, dbStage, _actor, _summary, reason) {
      calls.push({ id, dbStage, reason });
      rows![id].stage = dbStage;
    },
  };
  return { port, calls };
}

await test("every shared stage survives a round trip through both stores", () => {
  for (const s of stages.STAGES) {
    assert.equal(stages.stageFromJson(stages.jsonStatusFor(s)), s, `json ${s}`);
    assert.equal(stages.stageFromDb(stages.dbStageFor(s)), s, `db ${s}`);
  }
  // Every Postgres value reads as some stage, and the old JSON values are understood.
  for (const d of stages.DB_STAGES) assert.ok(stages.isStage(stages.stageFromDb(d)), d);
  assert.equal(stages.stageFromJson("booked"), "contacted");
  assert.equal(stages.stageFromJson("closed"), "lost");
  assert.equal(stages.stageFromDb("researching"), "new");
  assert.equal(stages.stageFromDb("meeting_booked"), "demo_watched");
  // A lead already inside the chosen stage keeps its finer value.
  assert.equal(stages.dbStageFor("contacted", "replied"), "replied");
  assert.equal(stages.dbStageFor("contacted", "qualified"), "contacted");
});

await test("the list merges JSON and Postgres leads with composite ids, sources and stages", async () => {
  const { port } = fakePort({ 1: { stage: "qualified" }, 2: { stage: "demo" } });
  const { leads: all, pipelineRead } = await leads.allLeads(port);
  assert.equal(pipelineRead, true);
  const byId = new Map(all.map((l) => [l.id, l]));
  assert.equal(byId.get("json:lead_enquiry")?.source, "enquiry");
  assert.equal(byId.get("json:lead_wa")?.source, "whatsapp");
  assert.equal(byId.get("json:lead_wa")?.stage, "contacted");
  assert.equal(byId.get("json:lead_dach")?.source, "waitlist_dach");
  assert.equal(byId.get("json:lead_dach")?.stage, "lost");
  assert.equal(byId.get("json:lead_dach")?.countryName, "Switzerland");
  assert.equal(byId.get("json:lead_chat")?.source, "website_belle");
  assert.equal(byId.get("db:1")?.source, "researched");
  assert.equal(byId.get("db:1")?.stage, "new");
  assert.equal(byId.get("db:1")?.hot, true, "a hot score is hot");
  assert.equal(byId.get("db:2")?.stage, "demo_sent");
  assert.equal(byId.get("db:2")?.drafts, 1);
  assert.equal(leads.filterLeads(all, { drafts: true }).map((l) => l.id).join(), "db:2");
  assert.equal(leads.filterLeads(all, { source: "waitlist_dach" }).length, 1);
  assert.equal(leads.filterLeads(all, { country: "ae" }).length, 2);
  assert.equal(leads.filterLeads(all, { q: "clinic1" }).map((l) => l.id).join(), "db:1");
  assert.deepEqual(leads.parseLeadId("db:12"), { store: "db", id: 12 });
  assert.equal(leads.parseLeadId("db:abc"), null);
  assert.equal(leads.parseLeadId("12"), null);
});

await test("without the sales database the list is the JSON leads, and says the pipeline was not read", async () => {
  const { leads: all, pipelineRead } = await leads.allLeads(fakePort(null).port);
  assert.equal(pipelineRead, false);
  assert.ok(all.every((l) => l.store === "json"));
  assert.equal(all.length, 4);
  // And the real port, with no DATABASE_URL, answers the same way rather than throwing.
  assert.equal((await leads.allLeads()).pipelineRead, false);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mStage, owner, next step, notes\x1b[0m\n");

await test("a stage change on an enquiry is written to the JSON lead and audited with who and why", async () => {
  const out = await leads.changeStage("json:lead_enquiry", "demo_sent", staff, "Sent the demo link on WhatsApp");
  assert.ok(out.ok);
  assert.equal(store.getLead("lead_enquiry")!.status, "demo_sent");
  const [row] = auditFor("json:lead_enquiry");
  assert.equal(row.action, "lead_stage_changed");
  assert.equal(row.actorId, staff.id);
  assert.equal(row.reason, "Sent the demo link on WhatsApp");
  assert.ok(Date.parse(row.at) > 0);
  const listed = (await leads.allLeads(fakePort(null).port)).leads.find((l) => l.id === "json:lead_enquiry")!;
  assert.equal(listed.stage, "demo_sent");
  assert.ok(leads.mergeTimeline("json:lead_enquiry", {}).some((t) => t.type === "stage_changed"));
});

await test("a stage change on a researched prospect is written to Postgres in its own vocabulary", async () => {
  const { port, calls } = fakePort({ 7: { stage: "qualified" } });
  const out = await leads.changeStage("db:7", "demo_watched", staff, null, port);
  assert.ok(out.ok);
  assert.deepEqual(calls, [{ id: 7, dbStage: "interested", reason: null }]);
  assert.equal(stages.stageFromDb((await port.stageOf(7))!), "demo_watched");
  assert.equal(auditFor("db:7")[0].action, "lead_stage_changed");
  const missing = await leads.changeStage("db:999", "lost", staff, "gone", port);
  assert.equal((missing as { status: number }).status, 404);
});

await test("Lost and Do not contact need a reason at the route", () => {
  const route = code(source("src/app/api/sales/leads/route.ts"));
  assert.match(route, /body\.stage === "lost" \|\| body\.stage === "do_not_contact"\) && reason\.length < 3/);
});

await test("owner, next step and notes are kept per lead and each change is audited", async () => {
  const id = "json:lead_wa";
  assert.ok((await leads.assignOwner(id, second.ok ? second.user.id : "", staff)).ok);
  const refused = await leads.assignOwner(id, owner.id, staff);
  assert.equal((refused as { status: number }).status, 422, "a customer cannot own a lead");
  assert.ok((await leads.setNextAction(id, "Call back about pricing", "2026-09-20", staff)).ok);
  assert.equal((await leads.setNextAction(id, "x", "20/09/2026", staff)).ok, false);
  assert.ok((await leads.addNote(id, "Prefers WhatsApp after 6pm.", staff)).ok);
  assert.equal((await leads.addNote(id, " ", staff)).ok, false);

  const crm = store.getLeadCrm(id)!;
  assert.equal(crm.ownerUserId, second.ok ? second.user.id : "");
  assert.equal(crm.nextAction, "Call back about pricing");
  assert.equal(crm.nextActionDue, "2026-09-20");
  assert.equal(crm.notes[0].text, "Prefers WhatsApp after 6pm.");
  assert.equal(crm.notes[0].by, staff.id);
  const actions = auditFor(id).map((r) => r.action).sort();
  assert.deepEqual(actions, ["lead_next_action_set", "lead_note_added", "lead_owner_changed"]);
  // The note's text is not copied into the audit trail, only that one was written.
  assert.ok(!JSON.stringify(auditFor(id)).includes("after 6pm"));

  const listed = (await leads.allLeads(fakePort(null).port)).leads.find((l) => l.id === id)!;
  assert.equal(listed.ownerName, "Rae Staff");
  assert.equal(leads.filterLeads([listed], { owner: second.ok ? second.user.id : "" }).length, 1);
  const timeline = leads.mergeTimeline(id, { createdAt: listed.createdAt, source: listed.source, viewer: staff });
  assert.ok(timeline.some((t) => t.type === "note" && t.body?.includes("after 6pm") && t.who === "You"));
  assert.ok(timeline.some((t) => t.type === "created"));
});

await test("the timeline hook: an outside event lands on the lead, and a watched demo makes it hot", async () => {
  assert.equal(leads.recordLeadEvent("nonsense", { type: "demo_watched", summary: "x", actor: "system" }), null);
  const event = leads.recordLeadEvent("json:lead_chat", { type: "demo_watched", summary: "Watched 90% of the video demo", actor: "system", data: { seconds: 54 } });
  assert.ok(event);
  const listed = (await leads.allLeads(fakePort(null).port)).leads.find((l) => l.id === "json:lead_chat")!;
  assert.equal(listed.hot, true);
  assert.ok(leads.mergeTimeline("json:lead_chat", {}).some((t) => t.type === "demo_watched"));
  // The lead page renders the video demo in its slot, for researched prospects only.
  const page = source("src/app/(internal)/sales/leads/[id]/page.tsx");
  assert.match(page, /id="video-demo"[\s\S]{0,120}<VideoDemoSlot lead=\{lead\} demos=\{demos\} \/>/);
  const slot = code(source("src/app/(internal)/sales/leads/[id]/VideoDemoSlot.tsx"));
  assert.match(slot, /if \(lead\.store !== "db"\) return null;/);
  assert.match(slot, /Create video demo/);
  assert.match(slot, /action: "revoke"/);
  // A demo that turns Hot uses this hook, so the list shows the lead hot too.
  assert.match(code(source("src/lib/sales/video-demo/service.ts")), /recordLeadEvent\(`db:\$\{updated\.leadId\}`, \{\s*type: "demo_watched"/);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mAn edited draft is checked again\x1b[0m\n");

const BODY = [
  "Hello,",
  "",
  "Your Marina branch has 400 reviews. Calls after 8pm go to voicemail.",
  "",
  "Belline answers those calls and takes the request.",
  "",
  "Hear your demo: https://app.belline.test/demo/marina",
  "",
  "Worth a two-minute listen?",
  "",
  "Best,",
].join("\n");
const PARTS = { observation: "Your Marina branch has 400 reviews.", problem: "Calls after 8pm go to voicemail.", solution: "Belline answers those calls and takes the request.", cta: "Worth a two-minute listen?" };
const CTX = {
  companyName: "Marina Smiles Dental",
  grounding: "Marina Smiles has 400 reviews. Phone line closes at 8pm.",
  allowedClaims: ["missed_call_recovery"],
  customerWord: "patient",
  forbiddenCustomerWords: ["guest"],
  maxWords: 90,
  recentBodies: [],
};

await test("an edit replaces only the parts the agent wrote, and refuses a body it cannot find them in", () => {
  const next = { ...PARTS, solution: "Belline picks up those calls and writes down what each patient needs." };
  const body = applyDraftEdit(BODY, PARTS, next)!;
  assert.ok(body.includes("writes down what each patient needs"));
  assert.ok(!body.includes("takes the request"));
  assert.ok(body.startsWith("Hello,") && body.includes("Hear your demo: https://app.belline.test/demo/marina"));
  assert.equal(applyDraftEdit("A body written by hand.", PARTS, next), null);
});

await test("the pre-send guards refuse an edit that breaks the rules, and a refused edit is held back", () => {
  assert.equal(checkDraft({ subject: "Calls after 8pm", ...PARTS }, CTX).problems.length, 0, "the original passes");
  const bad = cleanParts({ subject: "Re: your calls", observation: PARTS.observation, problem: PARTS.problem, solution: "Our AI-powered receptionist is guaranteed to reach out to every guest.", cta: PARTS.cta });
  const guard = checkDraft(bad, CTX);
  assert.ok(guard.problems.some((p) => /pretends to be a reply/.test(p)));
  assert.ok(guard.problems.some((p) => /technology/.test(p)));
  assert.ok(guard.problems.some((p) => /absolute promise/.test(p)));
  assert.ok(guard.problems.some((p) => /guests/.test(p)));
  assert.ok(flagsOf(guard).every((f) => !f.startsWith("warning:") || guard.warnings.length > 0));
  // saveDraftEdit stores a refused edit as `draft` (held back); approve re-runs the guard on what is stored.
  const lib = code(source("src/lib/staff/drafts.ts"));
  assert.match(lib, /const guard = checkDraft\(next, ctx\);\s*const status = guard\.problems\.length \? "draft" : "pending_approval";/);
  assert.match(lib, /if \(action === "approve"\) \{[\s\S]{0,400}guard = checkDraft\(\{ subject: draft\.subject, \.\.\.draft\.parts \}, ctx\);\s*if \(guard\.problems\.length\)/);
  assert.match(lib, /status: 422, error: "The checks refused this draft/);
});

await test("without the sales database the draft actions refuse plainly rather than pretend", async () => {
  for (const out of [await saveDraftEdit(1, PARTS, staff), await decideDraft(1, "approve", null, staff), await markDraftSent(1, staff)]) {
    assert.equal(out.ok, false);
    assert.equal((out as { status: number }).status, 503);
  }
  // Mark as sent only follows an approval, and records a hand-sent email; nothing delivers.
  const lib = code(source("src/lib/staff/drafts.ts"));
  assert.match(lib, /if \(draft\.status !== "approved"\)/);
  assert.doesNotMatch(lib, /deliverEmail|nodemailer|resend/i);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mCustomer actions, each audited\x1b[0m\n");

const today = todayIn("Asia/Dubai");
{
  const loc = store.getLocation(locationId)!;
  store.upsertLocation({ ...loc, subscription: { ...loc.subscription!, status: "trialing", trial: { ...(loc.subscription?.trial ?? { minutes: 100 }), endsOn: addDays(today, 3) } } });
}

await test("extend a trial: a whole number of days, a reason, a new end date, a record and an audit row", async () => {
  assert.equal((await customers.extendTrial(staff, tenantId, locationId, 0, "why not")).ok, false);
  assert.equal((await customers.extendTrial(staff, tenantId, locationId, 7, "")).ok, false);
  const out = await customers.extendTrial(staff, tenantId, locationId, 7, "Waiting on their carrier to forward calls");
  assert.ok(out.ok);
  const sub = store.getLocation(locationId)!.subscription!;
  assert.equal(sub.trial!.endsOn, addDays(today, 10));
  assert.equal(sub.trial!.staffExtensions![0].by, staff.id);
  assert.equal(sub.trial!.extendedFrom, undefined, "the automatic extension is not used up");
  const row = auditFor(locationId).find((r) => r.action === "trial_extended")!;
  assert.equal(row.reason, "Waiting on their carrier to forward calls");
  assert.deepEqual(row.after, { trialEndsOn: addDays(today, 10), days: 7 });
});

await test("change the plan: only a plan on sale in their country, recorded, never charged", async () => {
  const current = store.getLocation(locationId)!.subscription!.products ?? [];
  const plan = sellable("AE").find((p) => !current.includes(p.id))!;
  assert.equal((await customers.changePlan(staff, tenantId, locationId, current[0], "same plan")).ok, false, "already on it");
  assert.equal((await customers.changePlan(staff, tenantId, locationId, "enterprise", "old plan")).ok, false);
  const out = await customers.changePlan(staff, tenantId, locationId, plan.id, "Agreed on the call");
  assert.ok(out.ok, out.ok ? "" : out.error);
  const sub = store.getLocation(locationId)!.subscription!;
  assert.deepEqual(sub.products, [plan.id]);
  assert.equal(sub.staffPlanChanges![0].reason, "Agreed on the call");
  const row = auditFor(locationId).find((r) => r.action === "plan_changed")!;
  assert.equal((row.after as { charged: boolean }).charged, false);
  assert.doesNotMatch(code(source("src/lib/staff/customers.ts")), /stripe\.(subscriptions|invoices|charges)|createCheckout/i);
});

await test("suspend and reactivate the trial with the abuse review's own mechanism", async () => {
  const { paidWorkRefusal } = await import("../src/lib/abuse/gate");
  const verified = { ...owner, emailVerification: undefined, emailVerifiedAt: new Date().toISOString() };
  assert.ok((await customers.setTrialSuspended(staff, tenantId, true, "Looks like a second trial")).ok);
  assert.ok(store.getTenant(tenantId)!.abuse?.trialSuspendedAt);
  assert.equal(paidWorkRefusal(verified, store.getLocation(locationId))?.code, "trial_suspended");
  assert.equal((await customers.setTrialSuspended(staff, tenantId, true, "again")).ok, false, "already suspended");
  assert.ok((await customers.setTrialSuspended(staff, tenantId, false, "Checked with the owner")).ok);
  assert.equal(paidWorkRefusal(verified, store.getLocation(locationId)), null);
  assert.deepEqual(auditFor(tenantId).map((r) => r.action).filter((a) => a.startsWith("trial_")).sort(), ["trial_reactivated", "trial_suspended"]);
});

await test("cancel at the period's end only on a paid plan", async () => {
  assert.equal((await customers.cancelAtPeriodEnd(staff, tenantId, locationId, "Asked to stop")).ok, false, "a trial is not cancelled here");
  const loc = store.getLocation(locationId)!;
  store.upsertLocation({ ...loc, subscription: { ...loc.subscription!, status: "active" } });
  assert.ok((await customers.cancelAtPeriodEnd(staff, tenantId, locationId, "Asked to stop")).ok);
  assert.equal(store.getLocation(locationId)!.subscription!.status, "cancelled");
  assert.ok(auditFor(locationId).some((r) => r.action === "plan_cancelled_at_period_end" && r.reason === "Asked to stop"));
  store.upsertLocation({ ...store.getLocation(locationId)!, subscription: { ...store.getLocation(locationId)!.subscription!, status: "trialing", cancelledAt: undefined } });
});

await test("a password reset link works, is shown once, and never reaches the audit log", async () => {
  const out = await customers.resetLinkFor(staff, tenantId, owner.id);
  assert.ok(out.ok);
  const token = new URL(out.value.link).searchParams.get("t")!;
  assert.equal(peekResetToken(token)?.id, owner.id);
  assert.equal(out.value.minutes, 30);
  const row = auditFor(owner.id).find((r) => r.action === "password_reset_link_made")!;
  assert.ok(row);
  assert.ok(!JSON.stringify(store.listStaffAuditRows()).includes(token));
  const other = await customers.resetLinkFor(staff, tenantId, staff.id);
  assert.equal((other as { status: number }).status, 404, "a user of another tenant is not reachable through this customer");
});

await test("mark an email confirmed, and disable and enable a user: signed out at once, audited with the reason", async () => {
  const pendingUser = store.saveUser({ ...store.getUser(teammate.ok ? teammate.user.id : "")!, emailVerification: { required: true } });
  assert.ok((await customers.confirmEmail(staff, tenantId, pendingUser.id)).ok);
  assert.ok(store.getUser(pendingUser.id)!.emailVerifiedAt);
  assert.ok(auditFor(pendingUser.id).some((r) => r.action === "email_marked_confirmed"));

  const session = login("front@marina-smiles.test", PASSWORD);
  assert.ok(session.ok);
  assert.equal((await customers.setUserDisabled(staff, tenantId, pendingUser.id, true, "")).ok, false, "a reason is required");
  assert.ok((await customers.setUserDisabled(staff, tenantId, pendingUser.id, true, "Left the practice")).ok);
  assert.equal(store.getUser(pendingUser.id)!.disabled, true);
  assert.equal(store.getSession((session as { session: { id: string } }).session.id), undefined, "their sessions are gone");
  assert.equal(login("front@marina-smiles.test", PASSWORD).ok, false);
  assert.ok((await customers.setUserDisabled(staff, tenantId, pendingUser.id, false, "Came back")).ok);
  assert.equal(login("front@marina-smiles.test", PASSWORD).ok, true);
  assert.deepEqual(auditFor(pendingUser.id).filter((r) => r.action.startsWith("user_")).map((r) => r.reason), ["Left the practice", "Came back"]);
});

await test("edit the business details, audited with before and after", async () => {
  assert.ok((await customers.updateBusinessDetails(staff, tenantId, { name: "Marina Smiles Dental", category: "Dental practice", email: "hello@marina-smiles.test", phone: "+971 4 555 0101" })).ok);
  assert.equal(store.getTenant(tenantId)!.name, "Marina Smiles Dental");
  assert.equal(store.listBusinesses(tenantId)[0].category, "Dental practice");
  const row = auditFor(tenantId).find((r) => r.action === "customer_details_changed")!;
  assert.equal((row.before as { name: string }).name, "Marina Smiles");
  assert.equal((row.after as { name: string }).name, "Marina Smiles Dental");
  assert.equal((await customers.updateBusinessDetails(staff, tenantId, { name: "x" })).ok, false);
});

await test("the customer list is one row per business, never Belline's own", () => {
  const rows = customers.customerRows();
  assert.ok(rows.every((r) => !store.getTenant(r.tenantId)!.internal));
  const mine = rows.filter((r) => r.tenantId === tenantId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, "trial");
  assert.equal(mine[0].owner?.email, "owner@marina-smiles.test");
  assert.equal(customers.filterCustomers(rows, { q: "marina" }).length, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mView as customer is read-only\x1b[0m\n");

const staffLogin = login("staff@belline.test", PASSWORD);
assert.ok(staffLogin.ok);
const staffSessionId = (staffLogin as { session: { id: string } }).session.id;

await test("only staff may start a view, with a reason, of a real customer with an owner", async () => {
  assert.equal((await viewAs.startViewAs(owner, undefined, tenantId, "curious")).ok, false);
  assert.equal((await viewAs.startViewAs(staff, staffSessionId, tenantId, "")).ok, false);
  assert.equal((await viewAs.startViewAs(staff, staffSessionId, BELLINE_TENANT_ID, "look")).ok, false);
});

const lastSeenBefore = store.getUser(owner.id)!.lastSeenAt;
const started = await viewAs.startViewAs(staff, staffSessionId, tenantId, "Owner says the inbox is empty");
assert.ok(started.ok);
const viewId = (started as { session: { id: string } }).session.id;

await test("the view is a separate session as the owner, for 30 minutes, audited, and does not touch their last sign-in", () => {
  const s = store.getSession(viewId)!;
  assert.equal(s.userId, owner.id);
  assert.equal(s.viewAs!.staffUserId, staff.id);
  assert.equal(s.viewAs!.returnSessionId, staffSessionId);
  const minutes = (Date.parse(s.expiresAt) - Date.parse(s.createdAt)) / 60_000;
  assert.equal(minutes, 30);
  assert.equal(s.expiresAt, s.viewAs!.expiresAt);
  assert.equal(store.getUser(owner.id)!.lastSeenAt, lastSeenBefore);
  assert.ok(auditFor(tenantId).some((r) => r.action === "view_as_started" && r.actorId === staff.id && r.reason === "Owner says the inbox is empty"));
  assert.equal(viewAs.viewAsState(viewId)!.businessName, "Marina Smiles Dental");
});

await test("the server refuses every method but GET and HEAD on a view, and lets the exit through", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"]) {
    for (const p of ["/api/bookings", "/api/setup", "/api/auth/logout", "/api/sales/customers", "/"]) {
      const d = viewAs.decideViewAs(viewId, method, p);
      assert.equal(d.kind, "refuse", `${method} ${p}`);
      assert.equal((d as { status: number }).status, 403);
    }
  }
  assert.equal(viewAs.decideViewAs(viewId, "GET", "/requests").kind, "read_only");
  assert.equal(viewAs.decideViewAs(viewId, "HEAD", "/").kind, "read_only");
  assert.equal(viewAs.decideViewAs(viewId, "GET", viewAs.VIEW_AS_EXIT_PATH).kind, "exit");
  assert.equal(viewAs.decideViewAs(staffSessionId, "POST", "/api/bookings").kind, "normal");
  assert.equal(viewAs.decideViewAs(viewId, "GET", "/", Date.now() + 31 * 60_000).kind, "expired");
  assert.equal(viewAs.isViewAsSession(viewId), true);
});

await test("inside a view's request, every store write is refused before it changes anything", () => {
  const ctx = { reason: "viewing as a customer", staffUserId: staff.id, tenantId };
  const before = JSON.stringify(store.getUser(owner.id));
  const beforeLead = store.getLead("lead_chat")!.status;
  const attempts: [string, () => unknown][] = [
    ["saveUser", () => store.saveUser({ ...store.getUser(owner.id)!, name: "Changed" })],
    ["saveLead", () => store.saveLead({ ...store.getLead("lead_chat")!, status: "lost" })],
    ["upsertLocation", () => store.upsertLocation({ ...store.getLocation(locationId)!, name: "Changed" })],
    ["saveTenant", () => store.saveTenant({ ...store.getTenant(tenantId)!, name: "Changed" })],
    ["saveBooking", () => store.saveBooking({ id: "bk_x" } as never)],
    ["appendStaffAudit", () => store.appendStaffAudit({ id: "x", at: "", actorId: "", actorName: "", action: "", entity: "", entityId: "" })],
    ["saveLeadCrm", () => store.saveLeadCrm({ id: "json:lead_chat", notes: [], events: [], updatedAt: "" })],
    ["deleteUser", () => store.deleteUser(owner.id)],
  ];
  for (const [name, attempt] of attempts) {
    assert.throws(() => readonly.runReadOnly(ctx, attempt), (err: unknown) => err instanceof readonly.ReadOnlyError && (err as { status: number }).status === 403, name);
  }
  assert.equal(JSON.stringify(store.getUser(owner.id)), before, "nothing changed in memory");
  assert.equal(store.getLead("lead_chat")!.status, beforeLead);
  assert.equal(store.getTenant(tenantId)!.name, "Marina Smiles Dental");
  // Housekeeping is skipped, never an error, and reads work.
  readonly.runReadOnly(ctx, () => {
    // Every customer page starts with the boot-time migrations; on a view they are skipped, not refused.
    seedIfEmpty();
    store.pruneSessions();
    store.deleteSessions({ userId: owner.id });
    assert.equal(store.getUser(owner.id)!.id, owner.id);
  });
  assert.ok(store.getSession(viewId), "the view session was not deleted by housekeeping");
});

await test("inside a view's request, the database accepts reads and refuses writes before connecting", async () => {
  const ctx = { reason: "viewing as a customer" };
  assert.equal(db.isReadStatement("select * from sales.lead"), true);
  assert.equal(db.isReadStatement("  with x as (select 1) select * from x"), true);
  for (const sql of ["update sales.lead set stage = 'lost'", "insert into reception.message values (1)", "with d as (delete from sales.lead returning *) select * from d", "create table x (id int)"]) {
    assert.equal(db.isReadStatement(sql), false, sql);
    await assert.rejects(readonly.runReadOnly(ctx, () => db.query(sql)), readonly.ReadOnlyError, sql);
  }
  await assert.rejects(readonly.runReadOnly(ctx, () => db.tx(async () => 1)), readonly.ReadOnlyError);
});

await test("the async context carries through awaits, and ends with the request", async () => {
  const ctx = { reason: "viewing as a customer" };
  await readonly.runReadOnly(ctx, async () => {
    await new Promise((r) => setTimeout(r, 5));
    await Promise.resolve();
    assert.throws(() => store.saveUser(store.getUser(owner.id)!), readonly.ReadOnlyError);
  });
  store.saveUser(store.getUser(owner.id)!); // outside: fine
});

await test("server.ts decides every request and the voice socket before Next, and wraps reads read-only", () => {
  const server = code(source("server.ts"));
  const create = server.slice(server.indexOf("const server = createServer("), server.indexOf("const browserWss"));
  assert.match(create, /const view = decideViewAs\(sessionIdFromCookieHeader\(req\.headers\.cookie\), req\.method, parsed\.pathname \?\? "\/"\);/);
  assert.match(create, /view\.kind === "refuse"[\s\S]{0,120}res\.writeHead\(view\.status/);
  assert.match(create, /view\.kind === "read_only"[\s\S]{0,300}runReadOnly\([\s\S]{0,200}\(\) => handle\(req, res, parsed\)/);
  assert.ok(create.indexOf("decideViewAs(") < create.lastIndexOf("handle(req, res, parsed);"), "the decision comes before the plain handler");
  assert.match(server, /pathname === "\/ws\/voice" && isViewAsSession\(sessionIdFromCookieHeader\(req\.headers\.cookie\)\)\) \{\s*socket\.write\("HTTP\/1\.1 403/);
});

await test("the dashboard says it is a read-only view on every page, hides Belle, and offers the exit", () => {
  const layout = source("src/app/(app)/layout.tsx");
  assert.match(layout, /Viewing as \{view\.businessName\} — read-only/);
  assert.match(layout, /href=\{VIEW_AS_EXIT_PATH\}[\s\S]{0,60}Exit view/);
  assert.match(layout, /const belleVenue = view \? undefined :/);
});

await test("exit gives the staff member their own session back, removes the view and audits it", async () => {
  const out = await viewAs.exitViewAs(viewId);
  assert.equal(out.returnSessionId, staffSessionId);
  assert.equal(store.getSession(viewId), undefined);
  assert.ok(auditFor(tenantId).some((r) => r.action === "view_as_ended"));
  assert.equal(viewAs.decideViewAs(viewId, "POST", "/api/bookings").kind, "normal", "the old cookie is just a dead session now");
  assert.equal((await viewAs.exitViewAs(staffSessionId)).returnSessionId, null, "exit cannot end a normal session");
  assert.ok(store.getSession(staffSessionId));
});

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mMenu, addresses, words\x1b[0m\n");

await test("the menu is Today, Leads, Outreach, Customers, Issues, Revenue, Settings, then back to the customer dashboard", () => {
  const nav = source("src/app/(internal)/StaffNav.tsx");
  const labels = [...nav.matchAll(/\{ href: "([^"]+)", label: "([^"]+)" \}/g)].map((m) => `${m[2]} ${m[1]}`);
  assert.deepEqual(labels, ["Today /sales", "Leads /sales/leads", "Outreach /sales/outreach", "Customers /sales/customers", "Issues /sales/issues", "Revenue /sales/revenue", "Settings /sales/settings"]);
  assert.match(nav, /← Customer dashboard/);
  const staffGroup = source("src/lib/nav.ts").match(/function staffNav[\s\S]*?\n\}/)![0];
  assert.deepEqual([...staffGroup.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]), ["Staff console"]);
  assert.doesNotMatch(code(source("src/app/(internal)/layout.tsx")), /no link to it from the customer shell/);
});

await test("every old address redirects to its new home, and no page is left behind it", () => {
  const config = source("next.config.mjs");
  const moved: [string, string, string | null][] = [
    ["/sales/clients", "/sales/customers", "src/app/(internal)/sales/clients/page.tsx"],
    ["/sales/enquiries", "/sales/leads?source=enquiry", "src/app/(internal)/sales/enquiries/page.tsx"],
    ["/sales/approvals", "/sales/leads?view=drafts", "src/app/(internal)/sales/approvals/page.tsx"],
    ["/sales/exceptions", "/sales/issues", "src/app/(internal)/sales/exceptions/page.tsx"],
    ["/sales/abuse", "/sales/customers?view=flagged", "src/app/(internal)/sales/abuse/page.tsx"],
    ["/sales/activity", "/sales/settings/activity", "src/app/(internal)/sales/activity/page.tsx"],
    ["/sales/video", "/sales/settings/video", "src/app/(internal)/sales/video/page.tsx"],
    ["/sales/agents/:id", "/sales/settings/agents/:id", "src/app/(internal)/sales/agents/[id]/page.tsx"],
    ["/demo", "/sales/settings/demo-lines", "src/app/(app)/demo/page.tsx"],
    ["/prospects", "/sales/leads?build=1", "src/app/(app)/prospects/page.tsx"],
  ];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  for (const [from, to, page] of moved) {
    assert.match(config, new RegExp(`source: "${esc(from)}", destination: "${esc(to)}", permanent: false`), `${from} does not redirect to ${to}`);
    if (page) assert.ok(!fs.existsSync(path.join(ROOT, page)), `${page} is still there behind its redirect`);
  }
  // The public demo pages are not caught by the /demo redirect.
  assert.ok(fs.existsSync(path.join(ROOT, "src/app/demo/[slug]/page.tsx")));
  assert.ok(!/source: "\/demo\/:/.test(config));
});

await test("the console uses one header and one chip, and no browser dialog", () => {
  const files = walk("src/app/(internal)").filter((f) => /\.tsx$/.test(f));
  for (const f of files) {
    const text = code(fs.readFileSync(path.join(ROOT, f), "utf8"));
    assert.doesNotMatch(text, /window\.(prompt|confirm|alert)\s*\(/, f);
    assert.doesNotMatch(text, /<PageHeader\b/, `${f} uses the customer header`);
    assert.doesNotMatch(text, /function (Chip|Filter)\(/, `${f} defines its own chip`);
    assert.doesNotMatch(text, /window\.location\.reload\(/, `${f} reloads instead of refreshing`);
  }
});

await test("no engine jargon, raw data or dollars on the console's screens", () => {
  const banned = [/npm run worker/, /\bnoop\b/, /always_fails/, /sales\.message/, /DATABASE_URL/, /vertical agent/i, /Resolved configuration/, /after inheritance/, /"Qual\."|>Qual\./, /held back by a guard/i, /JSON\.stringify\(r\.context/, /\$\$\{/, /"\$"/, />\$\{/];
  const files = walk("src/app/(internal)").filter((f) => /\.tsx$/.test(f));
  const offenders: string[] = [];
  for (const f of files) {
    const text = code(fs.readFileSync(path.join(ROOT, f), "utf8"));
    for (const p of banned) if (p.test(text)) offenders.push(`${f}: ${p}`);
  }
  assert.deepEqual(offenders, []);
});

await test("Run now is not offered: the agents' page shows the commands and why, and posts nothing", () => {
  const page = code(source("src/app/(internal)/sales/settings/page.tsx"));
  assert.doesNotMatch(page, /Run now/);
  assert.doesNotMatch(page, /<Action\b|fetch\(/);
  for (const step of ["discover", "enrich", "research", "score", "demos", "draft"]) assert.match(page, new RegExp(`npm run ${step} -- `));
});

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exitCode = 1;
fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
