/**
 * `next build`, for an end-to-end harness that serves a production build.
 *
 * The harness env pins `NODE_ENV=development` (tests/selfserve/helpers.ts:
 * FLAG_STUBS refuses to boot under `NODE_ENV=production`, lib/flags.ts
 * `stubsRefusal`). A build must not inherit that or it compiles a development
 * bundle — HMR, development React, the lot — which is the thing the prod
 * harness exists to avoid. So the build runs in its own process with
 * `NODE_ENV=production`, and the server is then started with `--prod`, which
 * flips Next out of dev mode without claiming the environment is production.
 *
 * Cross-platform on purpose: it is spawned from a Playwright `webServer`
 * command, which runs through cmd on Windows and sh on Linux, and neither
 * agrees on `VAR=value cmd`.
 *
 *   node --import tsx scripts/build-e2e.ts
 */

import { spawnSync } from "node:child_process";

// One string, not a command plus an args array: with `shell: true` node warns
// about the latter (DEP0190), and there is nothing here to interpolate.
const result = spawnSync("npx next build", {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
});

if (result.status !== 0) {
  console.error(`\nnext build failed (exit ${result.status ?? "signal " + result.signal}).`);
  process.exit(result.status ?? 1);
}
