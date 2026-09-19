/**
 * Has it propagated, and does SES agree.
 *
 * Two different questions and the command asks both, because they fail
 * separately and confusingly. A record can be live in public DNS while SES
 * still says "pending" — it re-checks on its own schedule — and SES can say
 * "success" for DKIM while the MAIL FROM MX record was never added at all.
 * Reporting one number for both is how a domain gets marked ready and then
 * sends its first hundred messages unsigned.
 *
 * The resolver is an argument. Node's `dns/promises` is the real one, wired up
 * by the command; the check script passes a table of answers, so every branch
 * here is exercised with no network.
 */

import type { DnsRecord } from "./records";

export interface Resolver {
  resolveCname(name: string): Promise<string[]>;
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
}

export type RecordVerdict = "ok" | "missing" | "wrong" | "unchecked";

export interface RecordCheck {
  record: DnsRecord;
  verdict: RecordVerdict;
  /** What is actually there, when something is. */
  found: string[];
  note: string;
}

const clean = (value: string) => value.trim().toLowerCase().replace(/\.$/, "");

/**
 * Check one record against what DNS actually answers.
 *
 * `wrong` rather than `missing` when a record of the right type exists with
 * the wrong value, because those two need different things done about them:
 * one is a record to add, the other is usually a registrar's default that has
 * to be deleted first. Namecheap ships every domain with a parking CNAME and a
 * mail-forwarding MX, and both of them quietly win against what you just
 * typed.
 */
export async function checkRecord(record: DnsRecord, resolver: Resolver): Promise<RecordCheck> {
  const want = clean(record.value);
  try {
    if (record.kind === "CNAME") {
      const found = (await resolver.resolveCname(record.fqdn)).map(clean);
      return verdict(record, found, found.includes(want));
    }
    if (record.kind === "TXT") {
      // A TXT answer arrives as an array of chunks per record, because a
      // string over 255 bytes is split; joining them is not optional.
      const found = (await resolver.resolveTxt(record.fqdn)).map((chunks) => clean(chunks.join("")));
      return verdict(record, found, found.some((v) => sameTxt(v, want)));
    }
    const found = await resolver.resolveMx(record.fqdn);
    const shown = found.map((m) => `${m.priority} ${clean(m.exchange)}`);
    return verdict(
      record,
      shown,
      found.some((m) => clean(m.exchange) === want),
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { record, verdict: "missing", found: [], note: "nothing is published at that name yet" };
    }
    return { record, verdict: "unchecked", found: [], note: `could not be looked up: ${(err as Error).message}` };
  }
}

function verdict(record: DnsRecord, found: string[], matched: boolean): RecordCheck {
  if (matched) return { record, verdict: "ok", found, note: "published and correct" };
  if (found.length === 0) return { record, verdict: "missing", found, note: "nothing is published at that name yet" };
  return {
    record,
    verdict: "wrong",
    found,
    note: `something else is published there: ${found.join(", ")} — delete it before adding ours`,
  };
}

/**
 * Two SPF or DMARC strings that mean the same thing.
 *
 * Registrars normalise whitespace differently and some add a trailing
 * semicolon. Comparing byte for byte would report a correct record as wrong,
 * which sends somebody re-typing a record that was already right.
 */
function sameTxt(a: string, b: string): boolean {
  const norm = (v: string) =>
    v
      .replace(/\s*;\s*/g, ";")
      .replace(/\s+/g, " ")
      .replace(/;$/, "")
      .trim();
  return norm(a) === norm(b);
}

export interface VerifyReport {
  checks: RecordCheck[];
  ok: boolean;
  /** Only the ones needing something done, in the order to do them. */
  outstanding: RecordCheck[];
}

export async function checkAll(records: readonly DnsRecord[], resolver: Resolver): Promise<VerifyReport> {
  const checks: RecordCheck[] = [];
  for (const record of records) checks.push(await checkRecord(record, resolver));
  const outstanding = checks.filter((c) => c.verdict !== "ok" && !c.record.optional);
  return { checks, ok: outstanding.length === 0, outstanding };
}

// ---------------------------------------------------------------------------
// What SES itself thinks
// ---------------------------------------------------------------------------

export interface SesVerdict {
  line: string;
  ok: boolean;
}

/**
 * SES's own view, turned into sentences.
 *
 * Deliberately separate from the DNS check above and printed after it, so the
 * order a person reads is: here is what is missing in DNS, and here is what
 * AWS has noticed so far. SES re-checks DKIM and MAIL FROM on a timer of its
 * own, so "published but pending" is a normal state and the wording says to
 * wait rather than to change anything.
 */
export function describeIdentity(state: {
  verifiedForSending: boolean;
  dkimStatus: string | null;
  mailFromDomain: string | null;
  mailFromStatus: string | null;
  configurationSet: string | null;
} | null): SesVerdict[] {
  if (!state) {
    return [{ line: "SES has no identity for this domain — run the setup command first.", ok: false }];
  }
  const pending = (status: string | null) => status === "PENDING" || status === "NOT_STARTED";
  return [
    {
      line: state.verifiedForSending
        ? "SES has verified the domain and will send from it."
        : "SES has not verified the domain yet. It re-checks on its own; nothing to do but wait once DNS is right.",
      ok: state.verifiedForSending,
    },
    {
      line:
        state.dkimStatus === "SUCCESS"
          ? "DKIM is signing."
          : pending(state.dkimStatus)
            ? `DKIM is ${state.dkimStatus?.toLowerCase() ?? "pending"} — the three CNAMEs are published or SES has not looked yet.`
            : `DKIM is ${state.dkimStatus ?? "unknown"}. Check the three CNAMEs above.`,
      ok: state.dkimStatus === "SUCCESS",
    },
    {
      line: !state.mailFromDomain
        ? "No custom MAIL FROM is set, so the envelope sender is amazonses.com and SPF will not align."
        : state.mailFromStatus === "SUCCESS"
          ? `MAIL FROM is ${state.mailFromDomain}, and it is live.`
          : `MAIL FROM is ${state.mailFromDomain}, status ${state.mailFromStatus ?? "unknown"} — the MX and TXT above are what it is waiting for.`,
      ok: state.mailFromStatus === "SUCCESS",
    },
    {
      line: state.configurationSet
        ? `Events go to the configuration set ${state.configurationSet}.`
        : "No configuration set is attached, so bounces and complaints will not reach us.",
      ok: state.configurationSet !== null,
    },
  ];
}
