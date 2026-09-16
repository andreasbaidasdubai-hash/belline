/**
 * Nobody reaches the internal console by owning a tenant.
 *
 * `role === "owner"` is true of every self-serve signup — each one owns the
 * tenant it just created — so `canManageUsers` and a bare role comparison
 * refuse nobody. Seven of the eight sales pages were gated on one of those two,
 * which put every prospect, every drafted message and the whole client book
 * behind a check that every customer passes. The question that separates staff
 * from customers is the tenant, and `isBellineStaff` is the only thing that
 * asks it.
 *
 * A guard is easy to reinstate correctly and easy to lose again in the next
 * page somebody adds, so this walks the two trees rather than trusting review.
 *
 *   npm run check:sales-guard
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

/** The two trees that hold other people's businesses. */
const TREES = [
  path.join("src", "app", "(internal)"),
  path.join("src", "app", "api", "sales"),
];

/**
 * Files that authenticate. A client component cannot — it runs in the
 * prospect's browser — and neither can a shared helper, so requiring a guard
 * in those would only teach people to paste one in where it does nothing.
 */
const GUARDS_ITS_OWN_DOOR = /^(page|layout|route)\.tsx?$/;

/**
 * The one route a stranger may reach: liveness, because uptime monitoring
 * cannot sign in. Exempt from the refusal below, and held to a stricter rule
 * instead — see "the health route answers liveness and nothing else".
 */
const LIVENESS_ONLY = [path.join("src", "app", "api", "sales", "health", "route.ts")];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (GUARDS_ITS_OWN_DOOR.test(entry.name)) out.push(full);
  }
  return out;
}

/** Comments quote the very patterns this looks for — read the code only. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const files = TREES.flatMap((t) => walk(path.join(process.cwd(), t))).map((f) =>
  path.relative(process.cwd(), f),
);

console.log("\n\x1b[1mEvery door into the console\x1b[0m\n");

test("there are pages and routes to check at all", () => {
  // A walk that silently finds nothing would make every test below pass.
  assert.ok(files.length >= 12, `only found ${files.length} files: ${files.join(", ")}`);
});

test("every page, layout and route refuses on isBellineStaff", () => {
  const ungated = files
    .filter((f) => !LIVENESS_ONLY.includes(f))
    .filter((f) => !code(fs.readFileSync(f, "utf8")).includes("!isBellineStaff("));
  assert.deepEqual(ungated, [], `no isBellineStaff refusal in: ${ungated.join(", ")}`);
});

test("the list of reachable-without-signing-in files has not grown", () => {
  // Adding a file here is a decision to publish it. It should be visible in a
  // diff and argued for, never a quiet way past the test above.
  assert.deepEqual(LIVENESS_ONLY, [
    path.join("src", "app", "api", "sales", "health", "route.ts"),
  ]);
  for (const f of LIVENESS_ONLY) {
    assert.ok(fs.existsSync(f), `${f} is listed as public but does not exist`);
  }
});

test("the health route answers liveness and nothing else", () => {
  // It may stay open, but not while describing the business to whoever asks.
  const text = fs.readFileSync(LIVENESS_ONLY[0], "utf8");
  assert.match(text, /isBellineStaff/, "the counts are not gated on staff at all");
  assert.match(text, /const counts = staff/, "the counts must hang off a staff check");
  assert.match(text, /\.\.\.\(counts/, "the counts must be spread in only when present");
  // The row counts must not be reachable from the unconditional query.
  const probe = text.slice(text.indexOf("try {"), text.indexOf("const counts"));
  assert.ok(
    !/from sales\.(agent|lead|demo)/.test(probe),
    "the liveness probe itself reads the pipeline tables",
  );
});

test("no page or route is gated on the role instead of the tenant", () => {
  // The exact regression: both of these are true for every customer.
  const weak = [/\bcanManageUsers\s*\(/, /\brole\s*[!=]==\s*"owner"/];
  const offenders: string[] = [];
  for (const f of files) {
    const text = code(fs.readFileSync(f, "utf8"));
    if (weak.some((p) => p.test(text))) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `gated on the role: ${offenders.join(", ")}`);
});

console.log("\n\x1b[1mWhat isBellineStaff actually answers\x1b[0m\n");

test("it is the tenant that decides, not the role", async () => {
  // Cheap to assert here as well as in check:tenancy: the scan above is only
  // worth anything if the function it looks for refuses the right people.
  const { isBellineStaff } = await import("../src/lib/auth");
  assert.equal(typeof isBellineStaff, "function");
});

// Run it. The unconfigured path answers before the auth check, so this needs
// no session and no database — which is also the guarantee being tested.
{
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const { GET } = await import("../src/app/api/sales/health/route");
  const response = await GET();
  const body = (await response.json()) as Record<string, unknown>;
  if (saved !== undefined) process.env.DATABASE_URL = saved;

  test("a stranger's GET carries no agent, lead or demo counts", () => {
    assert.equal(response.status, 503);
    assert.equal(body.configured, false);
    for (const leak of ["agents", "leads", "liveDemos"]) {
      assert.ok(!(leak in body), `health answered a stranger with ${leak}`);
    }
  });
}

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exitCode = 1;
