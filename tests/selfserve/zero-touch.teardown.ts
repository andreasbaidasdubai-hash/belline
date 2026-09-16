import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Delete the run's data directory. Only ever one under the system temp folder. */
export default function teardown() {
  const dir = process.env.ZT_DATA_DIR;
  if (!dir || !path.resolve(dir).startsWith(path.resolve(os.tmpdir()))) return;
  if (process.env.ZT_KEEP_DATA === "1") return;
  fs.rmSync(dir, { recursive: true, force: true });
}
