/**
 * The wired resolver.
 *
 * `provider.ts` takes the SES constructor as an argument so that it can be
 * unit-tested without importing anything that can open a socket. This file is
 * the one place that ties the two together, and therefore the one import a
 * source scan has to look for to know whether a module can reach a real
 * provider.
 */

import { resolveAdapter as resolveWith, type AdapterResolution, type Env } from "../provider";
import { sesAdapter } from "./ses";

export function resolveAdapter(input: { domain: string; provider: string; env?: Env }): AdapterResolution {
  return resolveWith({ ...input, makeSes: sesAdapter });
}

export { sesAdapter };
