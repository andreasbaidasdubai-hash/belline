// Runs one shard of the check:* suites for CI.
//
//   node scripts/ci-checks.mjs <shard> <shards>
//
// Every `check` / `check:*` script in package.json except `check:all`, split
// evenly by index. The `--env-file` flag is stripped so no suite can ever load
// a .env (CI has none, and locally .env points at production). A suite that
// fails is reported by name; the process exits non-zero if any did.
import { execSync } from "node:child_process";
import fs from "node:fs";

const [shard = "0", shards = "1"] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const names = Object.keys(pkg.scripts)
  .filter((n) => (n === "check" || n.startsWith("check:")) && n !== "check:all")
  .sort()
  .filter((_, i) => i % Number(shards) === Number(shard));

const failed = [];
for (const name of names) {
  const command = pkg.scripts[name].replace(/\s--env-file(-if-exists)?=\S+/g, "");
  const started = Date.now();
  try {
    execSync(command, { stdio: "pipe", env: { ...process.env, DATABASE_URL: "" }, maxBuffer: 64 * 1024 * 1024 });
    console.log(`ok    ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (err) {
    failed.push(name);
    console.log(`FAIL  ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
    console.log(out.split("\n").slice(-60).join("\n"));
  }
}
console.log(`\nshard ${shard}/${shards}: ${names.length - failed.length} passed, ${failed.length} failed${failed.length ? `: ${failed.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
