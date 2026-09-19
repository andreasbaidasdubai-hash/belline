/**
 * Is the engine able to send anything at all, and if not, exactly why.
 *
 * One function, read by every screen and by the gate. With nothing configured
 * it reports `inert` and lists the variables a person has to set — it does not
 * half-work, it does not log "would have sent", and no screen is allowed to
 * imply otherwise. That is deliberate: the failure this project can least
 * afford is somebody believing mail is going out when it is not, or believing
 * it is not when it is.
 */

import { legalIdentity, identityIsEmpty, type LegalIdentity } from "../../legal/identity";
import { resolveAdapter } from "./adapters";
import { credentialState, REFUSED_PROVIDERS } from "./provider";
import { SENDING_DOMAIN_NAMES } from "./domains";
import { unsubscribeSecretPresent } from "./unsubscribe";
import { effectiveRule, realRules, type CountryOverride, type EffectiveCountry } from "./countries";
import { sendingStore, type SendingDomain, type SendingMailbox } from "./store";

export type Env = Record<string, string | undefined>;

export interface DomainReadiness {
  domain: SendingDomain;
  ready: boolean;
  /** Empty when ready; otherwise the environment variables to set. */
  missing: string[];
  reason: string | null;
  mailboxes: SendingMailbox[];
}

export interface EngineStatus {
  /** True when at least one domain can actually send. */
  ready: boolean;
  /** True when nothing at all is configured — the screens say this in words. */
  inert: boolean;
  domains: DomainReadiness[];
  /** Sender identity, and whether it is complete enough for each open country. */
  identity: LegalIdentity;
  identityEmpty: boolean;
  countries: EffectiveCountry[];
  canSignUnsubscribe: boolean;
  /** Everything a person has to do, in order, to make the engine live. */
  todo: string[];
  storeKind: "postgres" | "memory";
}

export async function engineStatus(env: Env = process.env): Promise<EngineStatus> {
  const store = sendingStore();
  const [domains, mailboxes, overrides] = await Promise.all([
    store.listDomains(),
    store.listMailboxes(),
    store.listCountryOverrides(),
  ]);

  const identity = legalIdentity(env);
  const canSignUnsubscribe = unsubscribeSecretPresent(env);

  const readiness: DomainReadiness[] = domains
    .filter((d) => d.purpose === "cold")
    .map((domain) => {
      const own = mailboxes.filter((m) => m.domainId === domain.id);
      const refused = REFUSED_PROVIDERS[domain.provider];
      if (refused) return { domain, ready: false, missing: [], reason: refused, mailboxes: own };

      const resolution = resolveAdapter({ domain: domain.domain, provider: domain.provider, env });
      if (!resolution.ok) {
        return { domain, ready: false, missing: resolution.missing, reason: resolution.reason, mailboxes: own };
      }
      if (domain.status === "paused" || domain.status === "retired") {
        return { domain, ready: false, missing: [], reason: domain.pausedReason ?? `domain is ${domain.status}`, mailboxes: own };
      }
      if (own.length === 0) {
        return { domain, ready: false, missing: [], reason: "no mailboxes on this domain", mailboxes: own };
      }
      return { domain, ready: true, missing: [], reason: null, mailboxes: own };
    });

  const countries = realRules().map((rule) => effectiveRule(rule.code, overrides as CountryOverride[]));
  const ready = readiness.some((d) => d.ready) && canSignUnsubscribe;
  const inert = !ready;

  const todo: string[] = [];
  const cold = domains.filter((d) => d.purpose === "cold");
  if (cold.length === 0) {
    todo.push("Register a lookalike sending domain and add it here. belline.ai must never carry cold mail.");
  }
  // Domains we own but this deployment has never been told about. Without
  // this the engine sends happily from whichever two of the four made it into
  // the database, and nobody notices the other two are idle — they were paid
  // for, warmed up and DNS-configured, and their whole value is spreading the
  // volume. SENDING_DOMAINS is the one list; their public pages are built from
  // it too, so a domain missing here is also a domain whose page is up.
  const known = new Set(cold.map((d) => d.domain.toLowerCase()));
  const unregistered = SENDING_DOMAIN_NAMES.filter((d) => !known.has(d));
  if (cold.length > 0 && unregistered.length > 0) {
    todo.push(
      `${unregistered.join(", ")}: owned and DNS-configured but not added to this deployment — run 'npm run domain:setup' for each.`,
    );
  }
  for (const entry of readiness) {
    if (entry.ready) continue;
    if (entry.missing.length > 0) {
      todo.push(`${entry.domain.domain}: set ${entry.missing.join(", ")}.`);
    } else if (entry.reason) {
      todo.push(`${entry.domain.domain}: ${entry.reason}`);
    }
  }
  if (!canSignUnsubscribe) {
    todo.push("Set OUTREACH_UNSUBSCRIBE_SECRET. Without it no opt-out link can be signed and nothing may be sent.");
  }
  const openDach = countries.filter((c) => c.enabled && c.language === "de");
  if (openDach.length > 0) {
    for (const country of openDach) {
      const gaps = country.requiresIdentity.filter((f) => !identity[f]?.trim());
      if (gaps.length > 0) {
        todo.push(`${country.label} is switched on but the sender identity is incomplete — fill ${gaps.join(", ")} in src/lib/legal/identity.ts.`);
      }
    }
  }

  return {
    ready,
    inert,
    domains: readiness,
    identity,
    identityEmpty: identityIsEmpty(identity),
    countries,
    canSignUnsubscribe,
    todo,
    storeKind: store.kind,
  };
}

/** The credential picture for one domain, without building an adapter. */
export function domainCredentials(domain: string, env: Env = process.env) {
  return credentialState(domain, env);
}

/**
 * A single sentence for a screen header.
 *
 * Kept here rather than in a component so that `check:sales-honesty` has one
 * string to reason about instead of six.
 */
export function statusSentence(status: EngineStatus): string {
  if (status.ready) {
    const live = status.domains.filter((d) => d.ready).length;
    return `Sending is live on ${live} domain${live === 1 ? "" : "s"}. Nothing leaves without an approved batch.`;
  }
  if (status.domains.length === 0) {
    return "No sending domain has been added, so this engine cannot send anything.";
  }
  return "No sending credentials are configured, so this engine is inert — nothing can be sent.";
}
