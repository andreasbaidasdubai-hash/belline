/**
 * The shared Postgres client, from where it now lives.
 *
 * The implementation moved to `src/lib/db/client.ts` when reception needed the
 * same pool. This file stays so the forty-odd call sites under `sales/` keep
 * working and so there is exactly one pool in the process — two modules each
 * creating their own is how you end up being refused connections.
 */
export {
  isConfigured,
  pool,
  query,
  one,
  tx,
  isUniqueViolation,
  close,
} from "../../db/client";
