/**
 * Check scripts never touch a shared database.
 *
 * The repo's `.env` points at the Postgres production and staging share, and
 * a handful of `check:*` scripts used to load it. Every one of those runs
 * wrote test rows into production: 39 noop jobs, one of them still stuck.
 * Removing `--env-file` from package.json fixes today; this fixes the next
 * time someone types `node --env-file=.env scripts/check-queue.ts` by hand.
 *
 * The rule is plain. A process whose entry script is `check-*` may only reach
 * a database on this machine, the deliberately unreachable
 * `disabled.invalid`, or the one host named in `ALLOW_CHECK_DB` (a staging
 * database someone set up on purpose). Anything else is refused before a
 * connection is opened. The message names the host but never the password.
 *
 * Pure and dependency-free, so both the pool and the stub layer can use it.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "disabled.invalid"]);

/** True when the entry script is one of `scripts/check-*`. */
export function isCheckProcess(argv: readonly string[] = process.argv): boolean {
  const entry = argv[1] ?? "";
  const base = entry.split(/[\\/]/).pop() ?? "";
  return /^check-[\w-]+\.(ts|mts|js|mjs)$/.test(base);
}

/** The hostname in a connection string, or null when it cannot be read. */
export function dbHostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

/** A database on this machine, or the placeholder that never resolves. */
export function isLocalDbUrl(url: string): boolean {
  const host = dbHostOf(url);
  return host !== null && LOCAL_HOSTS.has(host);
}

/**
 * Why this process must not connect, or null when it may.
 *
 * Only check processes are judged; the app and the worker connect wherever
 * they are told to.
 */
export function checkDbRefusal(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
): string | null {
  if (!isCheckProcess(argv)) return null;
  const url = env.DATABASE_URL ?? "";
  if (!url) return null;
  if (isLocalDbUrl(url)) return null;

  const host = dbHostOf(url);
  const allowed = (env.ALLOW_CHECK_DB ?? "").trim().toLowerCase();
  if (host && allowed && host === allowed) return null;

  const script = (argv[1] ?? "").split(/[\\/]/).pop();
  return (
    `Refusing to connect: ${script} is a check script and DATABASE_URL points at ` +
    `${host ?? "an address that cannot be read"}, which is not a local database. ` +
    "Checks never run against a shared database. Unset DATABASE_URL, point it at localhost, " +
    "or set ALLOW_CHECK_DB=<host> for a staging database set up for tests."
  );
}
