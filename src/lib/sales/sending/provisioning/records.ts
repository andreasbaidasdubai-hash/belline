/**
 * The DNS records a sending domain needs, and where each value comes from.
 *
 * The rule this file exists to enforce: **nothing is invented**. Every value
 * below is either a constant AWS documents, something derived from the domain
 * name, or a token that came back from the SES API a moment ago. There is no
 * placeholder, no `<your-token-here>`, and no record emitted on a guess —
 * because a DNS record that is nearly right is a domain that verifies, sends,
 * and lands in spam for a month before anybody works out why.
 *
 * The DKIM tokens in particular can only come from AWS. If the identity has
 * not been created yet there are no tokens, and this file says so rather than
 * printing three plausible-looking strings.
 *
 * Shaped for Namecheap's Advanced DNS table, which is where these are going to
 * be typed: a host that is `@` or a bare subdomain rather than a fully
 * qualified name, the priority in its own column, and a TTL in seconds.
 */

export type RecordKind = "CNAME" | "TXT" | "MX";

export interface DnsRecord {
  kind: RecordKind;
  /** Namecheap's "Host": `@` for the root, otherwise the label without the domain. */
  host: string;
  /** The fully qualified name, for anyone checking with `dig`. */
  fqdn: string;
  value: string;
  priority?: number;
  ttl: number;
  /** What this record is for, in one line, printed beside it. */
  purpose: string;
  /** True when mail still works without it, so a person can triage. */
  optional?: boolean;
}

export type DmarcPolicy = "none" | "quarantine" | "reject";

export interface RecordsInput {
  domain: string;
  /** From `GetEmailIdentity`. Three of them, and only AWS can produce them. */
  dkimTokens: readonly string[];
  /** The custom MAIL FROM subdomain, e.g. `mail` for `mail.try-belline.com`. */
  mailFromLabel: string;
  /** The SES region the identity lives in. Decides the two AWS hostnames. */
  region: string;
  /** Where DMARC reports go. Omitted rather than faked when nobody gave one. */
  dmarcReports?: string | null;
  dmarcPolicy?: DmarcPolicy;
  /** False for a domain that only sends, so no inbound MX is printed. */
  receivesReplies?: boolean;
  ttl?: number;
}

const DEFAULT_TTL = 1800;

/**
 * The SES regions that can receive mail.
 *
 * Sending works in every region; receiving does not, and a receipt rule set
 * cannot be created in one that is missing from this list. Worth refusing
 * early: the alternative is a domain whose MX points at a hostname that does
 * not resolve, and replies that vanish.
 */
export const INBOUND_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "eu-west-1",
  "eu-west-2",
  "eu-central-1",
  "eu-north-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-south-1",
  "ca-central-1",
  "sa-east-1",
  "il-central-1",
] as const;

export function regionCanReceive(region: string): boolean {
  return (INBOUND_REGIONS as readonly string[]).includes(region);
}

/** Namecheap wants the label, not the fully qualified name. */
export function hostFor(fqdn: string, domain: string): string {
  if (fqdn === domain) return "@";
  return fqdn.endsWith(`.${domain}`) ? fqdn.slice(0, -(domain.length + 1)) : fqdn;
}

export function dnsRecords(input: RecordsInput): DnsRecord[] {
  const domain = input.domain.trim().toLowerCase().replace(/\.$/, "");
  const ttl = input.ttl ?? DEFAULT_TTL;
  const mailFrom = `${input.mailFromLabel}.${domain}`;
  const records: DnsRecord[] = [];

  const add = (record: Omit<DnsRecord, "host" | "ttl"> & { ttl?: number }) =>
    records.push({ ...record, host: hostFor(record.fqdn, domain), ttl: record.ttl ?? ttl });

  // --- DKIM: three CNAMEs, and only AWS knows the tokens -------------------
  for (const token of input.dkimTokens) {
    add({
      kind: "CNAME",
      fqdn: `${token}._domainkey.${domain}`,
      value: `${token}.dkim.amazonses.com`,
      purpose: "Easy DKIM — SES signs with a key it holds; this points at the public half",
    });
  }

  // --- SPF at the root -----------------------------------------------------
  //
  // `-all`, not `~all`. This is a dedicated cold-mail domain that sends
  // through exactly one provider; a soft fail on a domain with one sender is
  // an invitation to spoof it, and spoofing is how a lookalike domain's
  // reputation is destroyed by somebody who is not us.
  add({
    kind: "TXT",
    fqdn: domain,
    value: "v=spf1 include:amazonses.com -all",
    purpose: "SPF — SES is the only thing allowed to send as this domain",
  });

  // --- DMARC ---------------------------------------------------------------
  const policy = input.dmarcPolicy ?? "quarantine";
  const dmarc = [
    "v=DMARC1",
    `p=${policy}`,
    input.dmarcReports ? `rua=mailto:${input.dmarcReports}` : null,
    // Relaxed alignment: the MAIL FROM is a subdomain of the From domain, so
    // strict alignment would fail SPF alignment on every message we send.
    "adkim=r",
    "aspf=r",
    "pct=100",
  ]
    .filter(Boolean)
    .join("; ");
  add({
    kind: "TXT",
    fqdn: `_dmarc.${domain}`,
    value: dmarc,
    purpose: `DMARC — tells a receiver what to do when SPF and DKIM disagree (p=${policy})`,
  });

  // --- The custom MAIL FROM subdomain --------------------------------------
  //
  // Worth the two extra records: without it the envelope sender is
  // amazonses.com, SPF aligns to Amazon rather than to us, and DMARC passes on
  // DKIM alone. With it, both halves align, which is the difference between
  // "authenticated" and "authenticated by the same domain the recipient sees".
  add({
    kind: "MX",
    fqdn: mailFrom,
    value: `feedback-smtp.${input.region}.amazonses.com`,
    priority: 10,
    purpose: "MAIL FROM — where bounce reports for this domain are delivered",
  });
  add({
    kind: "TXT",
    fqdn: mailFrom,
    value: "v=spf1 include:amazonses.com -all",
    purpose: "MAIL FROM SPF — the envelope sender's own record",
  });

  // --- Receiving replies ---------------------------------------------------
  if (input.receivesReplies !== false) {
    add({
      kind: "MX",
      fqdn: domain,
      value: `inbound-smtp.${input.region}.amazonaws.com`,
      priority: 10,
      purpose: "Receiving — where replies to this domain are delivered, for /api/sales/inbound",
    });
  }

  return records;
}

/**
 * Everything that can only come from a person, said plainly.
 *
 * The command prints this before it prints anything else. A setup that is
 * half-done and silent about which half is the thing that takes an afternoon;
 * a setup that says "these four values are yours to decide" takes a minute.
 */
export interface HumanInputs {
  label: string;
  why: string;
  value: string | null;
}

export function whatOnlyAPersonKnows(input: {
  domain: string;
  dmarcReports?: string | null;
  topicArn?: string | null;
  bucket?: string | null;
  mailboxes: readonly string[];
}): HumanInputs[] {
  return [
    {
      label: "The domain itself",
      why: "A lookalike, registered by you. Never belline.ai — that carries customers' transactional mail.",
      value: input.domain,
    },
    {
      label: "Mailbox addresses and the names on them",
      why: "A real person's name a recipient will recognise, not a role address.",
      value: input.mailboxes.length > 0 ? input.mailboxes.join(", ") : null,
    },
    {
      label: "DMARC report address",
      why: "Where aggregate reports go. Optional, but without it nobody ever sees an alignment failure.",
      value: input.dmarcReports ?? null,
    },
    {
      label: "SNS topic for bounce, complaint, delivery and reject events",
      why: "Created once in the AWS console; the same topic can serve every sending domain.",
      value: input.topicArn ?? null,
    },
    {
      label: "S3 bucket for received mail",
      why: "Where the SES receipt rule writes inbound messages. One bucket for all domains.",
      value: input.bucket ?? null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/** A fixed-width table, the shape of Namecheap's own Advanced DNS screen. */
export function asNamecheapTable(records: readonly DnsRecord[]): string {
  const header = ["Type", "Host", "Value", "Priority", "TTL"];
  const rows = records.map((r) => [
    r.kind,
    r.host,
    r.value,
    r.priority === undefined ? "" : String(r.priority),
    String(r.ttl),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

/** The same records as a zone file, for a registrar that takes one. */
export function asZoneFile(records: readonly DnsRecord[]): string {
  return records
    .map((r) => {
      const value = r.kind === "TXT" ? `"${r.value}"` : r.kind === "MX" ? `${r.priority ?? 10} ${r.value}.` : `${r.value}.`;
      return `${r.fqdn}.\t${r.ttl}\tIN\t${r.kind}\t${value}`;
    })
    .join("\n");
}
