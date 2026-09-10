/**
 * The Business Brain.
 *
 * Versioning earns its keep only if the four questions asked after something
 * goes wrong actually have answers: who changed it, when, what changed, and
 * which version handled the call being complained about. These test exactly
 * those, plus the property that makes a history evidence rather than a note —
 * that it cannot be edited, only added to.
 *
 *   npm run check:brain
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-brain-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations, getLocation, upsertLocation } = await import("../src/lib/store");
const { publish, revertTo, historyFor, currentVersion, changedSections, snapshotOf } =
  await import("../src/lib/brain");
const { startCall } = await import("../src/lib/calls");

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  [32m✓[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  [31m✗[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

seedIfEmpty();
const venueId = listLocations()[0].id;
const andreas = { id: "usr_1", name: "Andreas" };

console.log("\nA venue always has a baseline\n");

test("seeding publishes version 1", () => {
  const version = currentVersion(getLocation(venueId)!);
  assert.ok(version, "no version at all");
  assert.equal(version.number, 1);
  assert.equal(version.authorId, "system");
});

console.log("\nEvery change is recorded\n");

test("editing a policy publishes version 2", () => {
  const before = getLocation(venueId)!;
  upsertLocation({
    ...before,
    agent: { ...before.agent, policies: [...before.agent.policies, "No dogs on the terrace."] },
  });
  const result = publish(venueId, andreas, "Added the terrace dog policy");
  assert.ok(result?.changed, "the change was not recorded");
  assert.equal(result.version.number, 2);
});

test("it records who, when and why", () => {
  const version = currentVersion(getLocation(venueId)!)!;
  assert.equal(version.authorName, "Andreas");
  assert.equal(version.note, "Added the terrace dog policy");
  assert.ok(Date.now() - new Date(version.createdAt).getTime() < 60_000);
});

test("it records which part of the brain moved", () => {
  const version = currentVersion(getLocation(venueId)!)!;
  assert.deepEqual(version.touched, ["policies"]);
});

test("publishing again with nothing changed adds no version", () => {
  const before = historyFor(getLocation(venueId)!).length;
  const result = publish(venueId, andreas, "Nothing at all");
  assert.equal(result?.changed, false, "an empty change was recorded");
  assert.equal(historyFor(getLocation(venueId)!).length, before);
});

test("changing the voice is a style change, not a policy one", () => {
  const before = getLocation(venueId)!;
  upsertLocation({ ...before, agent: { ...before.agent, voiceSpeed: 1.12 } });
  const result = publish(venueId, andreas, "Slightly quicker");
  assert.ok(result?.changed);
  assert.deepEqual(result.version.touched, ["style"]);
});

console.log("\nA version means what it meant when it was published\n");

test("a snapshot does not change when the venue does", () => {
  const taken = currentVersion(getLocation(venueId)!)!;
  const policiesThen = [...taken.snapshot.agent.policies];

  const live = getLocation(venueId)!;
  upsertLocation({ ...live, agent: { ...live.agent, policies: ["Everything is different now."] } });

  const stillThere = historyFor(getLocation(venueId)!).find((v) => v.number === taken.number)!;
  assert.deepEqual(
    stillThere.snapshot.agent.policies,
    policiesThen,
    "editing the venue rewrote its own history",
  );
});

console.log("\nRolling back\n");

test("reverting restores the older configuration", () => {
  publish(venueId, andreas, "Wiped the policies");
  const result = revertTo(venueId, 2, andreas);
  assert.ok(result?.changed, "revert did nothing");
  const live = getLocation(venueId)!;
  assert.ok(
    live.agent.policies.some((p) => p.includes("dogs on the terrace")),
    "the old policy did not come back",
  );
});

test("a revert is itself a new version, not a deletion", () => {
  const history = historyFor(getLocation(venueId)!);
  const newest = history[0];
  assert.ok(newest.number > 2, "the history was truncated instead of extended");
  assert.equal(newest.revertedFrom, 2, "the revert did not say what it restored");
  // Every version that ever existed is still there.
  const numbers = history.map((v) => v.number).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, i) => i + 1));
});

console.log("\nCalls carry the version that answered them\n");

test("a call records the live version number", () => {
  const live = getLocation(venueId)!;
  const call = startCall(live, "phone", "+441234567890");
  assert.equal(call.brainVersion, currentVersion(live)!.number);
});

test("a later edit does not rewrite what an old call ran under", () => {
  const live = getLocation(venueId)!;
  const call = startCall(live, "phone", "+441234567890");
  const answeredUnder = call.brainVersion;

  upsertLocation({ ...live, agent: { ...live.agent, persona: "Completely different." } });
  publish(venueId, andreas, "New persona");

  assert.equal(call.brainVersion, answeredUnder, "an old call changed its own history");
  assert.notEqual(currentVersion(getLocation(venueId)!)!.number, answeredUnder);
});

console.log("\nDiffing\n");

test("a first version counts as everything changed", () => {
  const sections = changedSections(null, snapshotOf(getLocation(venueId)!));
  assert.ok(sections.includes("company"));
  assert.ok(sections.includes("services"));
  assert.ok(sections.includes("style"));
});

test("identical snapshots differ in nothing", () => {
  const snap = snapshotOf(getLocation(venueId)!);
  assert.deepEqual(changedSections(snap, snap), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\n[32m✓ ${passed} passed, 0 failed[0m\n`
    : `\n[31m✗ ${passed} passed, ${failed} failed[0m\n`,
);
if (failed > 0) process.exitCode = 1;
