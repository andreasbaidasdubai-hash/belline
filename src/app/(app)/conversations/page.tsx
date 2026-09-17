import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { listCalls } from "@/lib/store";
import { loadInbox } from "@/lib/reception/inbox-view";
import { callDurationSeconds } from "@/lib/calls";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import SectionTabs from "@/components/SectionTabs";
import { INBOX_TABS } from "@/lib/nav";

export const dynamic = "force-dynamic";

export const metadata = { title: "Conversations" };

/**
 * Every conversation, on every channel, in one list.
 *
 * Belline answers a phone line, a website and a WhatsApp number, and until
 * now the dashboard showed those in two different places with two different
 * shapes — /calls for anything with audio, /inbox for anything typed. The
 * owner does not think in transports. They think "somebody got in touch and
 * I want to know what was said".
 *
 * A reading layer, deliberately. Both underlying screens keep their jobs:
 * this links to /calls/[id] for a transcript and tool trace, and to /inbox
 * for a thread that can still be taken over and replied to. Nothing is
 * duplicated except the sorting.
 *
 * Two sources with two failure modes. Calls are in the store and are always
 * there. Messages live in Postgres, which can be unreachable — `loadInbox`
 * already turns that into a state rather than an exception, and this page
 * says so in place of the typed conversations while still showing every
 * call, because the phone does not depend on that database.
 */

type Row = {
  key: string;
  at: string;
  channel: string;
  who: string;
  what: string;
  outcome: string;
  tone?: "warn";
  href: string;
  detail?: string;
};

/** The channel as an owner would say it, not as the transport names it. */
const CHANNEL_LABEL: Record<string, string> = {
  phone: "Phone",
  whatsapp: "WhatsApp",
  webchat: "Website chat",
  embed: "Website voice",
  browser: "Test console",
  web: "Website chat",
  sms: "SMS",
};

const label = (channel: string) => CHANNEL_LABEL[channel] ?? channel;

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string; channel?: string; outcome?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc, channel, outcome } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const calls = listCalls(location.id).filter((c) => !c.isDemo);
  const inbox = await loadInbox(user, undefined);

  const callRows: Row[] = calls.map((c) => {
    const needsSomeone = Boolean(c.escalation);
    return {
      key: `call_${c.id}`,
      at: c.startedAt,
      channel: label(c.channel),
      who: c.from && c.from !== "browser-console" ? c.from : "Unknown caller",
      what: c.summary ?? c.transcript.find((t) => t.role === "caller")?.text ?? "(no exchange)",
      outcome: needsSomeone ? "Needs someone" : (c.outcome ?? (c.status === "active" ? "In progress" : "Handled")),
      tone: needsSomeone ? "warn" : undefined,
      href: `/calls/${c.id}`,
      detail: `${callDurationSeconds(c)}s`,
    };
  });

  const messageRows: Row[] =
    inbox.state === "ok"
      ? inbox.conversations.map((c) => {
          // A thread a person has taken over carries the reason it was handed
          // over. That, rather than the status enum, is the thing an owner is
          // scanning this column for.
          const handed = Boolean(c.handoffReason);
          return {
            key: `conv_${c.id}`,
            at: c.lastMessageAt,
            channel: label(c.channel),
            who: inbox.names[c.id] ?? "Unknown",
            what: inbox.previews[c.id] || "(no messages)",
            outcome: handed ? (c.handoffReason ?? "With your team") : "Handled",
            tone: handed ? "warn" : undefined,
            href: `/inbox?id=${c.id}`,
          };
        })
      : [];

  const all = [...callRows, ...messageRows].sort((a, b) => b.at.localeCompare(a.at));

  const channels = [...new Set(all.map((r) => r.channel))].sort();
  const outcomes = [...new Set(all.map((r) => r.outcome))].sort();
  const rows = all.filter(
    (r) => (!channel || r.channel === channel) && (!outcome || r.outcome === outcome),
  );

  const link = (next: { channel?: string; outcome?: string }) => {
    const p = new URLSearchParams();
    if (loc) p.set("loc", loc);
    const ch = "channel" in next ? next.channel : channel;
    const oc = "outcome" in next ? next.outcome : outcome;
    if (ch) p.set("channel", ch);
    if (oc) p.set("outcome", oc);
    const q = p.toString();
    return q ? `/conversations?${q}` : "/conversations";
  };

  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Every call, website chat and WhatsApp message in one list, newest first. Open any of them for the full transcript of what was said."
      />
      <LocationTabs base="/conversations" active={location.id} />
      <SectionTabs tabs={INBOX_TABS} label="Inbox" />

      {inbox.state !== "ok" && (
        <div className="panel" role="status" style={{ padding: "12px 16px", marginBottom: 14, fontSize: 13, lineHeight: 1.6 }}>
          {inbox.state === "not-configured"
            ? "Website chat and WhatsApp are not switched on for this account yet. Calls are answered as normal and are listed below."
            : "Typed conversations can't be loaded right now, so only calls are listed. Phone calls don't depend on that and are still being answered."}
        </div>
      )}

      <div className="loc-tabs" style={{ marginBottom: 14, gap: 6, flexWrap: "wrap" }}>
        <Link href={link({ channel: undefined })} className="pill" aria-current={!channel ? "true" : undefined}>
          All channels
        </Link>
        {channels.map((c) => (
          <Link key={c} href={link({ channel: c })} className="pill" aria-current={channel === c ? "true" : undefined}>
            {c}
          </Link>
        ))}
        <span aria-hidden="true" style={{ width: 10 }} />
        <Link href={link({ outcome: undefined })} className="pill" aria-current={!outcome ? "true" : undefined}>
          Any outcome
        </Link>
        {outcomes.map((o) => (
          <Link key={o} href={link({ outcome: o })} className="pill" aria-current={outcome === o ? "true" : undefined}>
            {o}
          </Link>
        ))}
      </div>

      <div className="panel">
        {rows.length === 0 ? (
          <p className="muted" style={{ padding: "30px 18px", margin: 0, fontSize: 13 }}>
            {all.length === 0 ? (
              <>
                Nothing yet. Try it yourself under{" "}
                <Link href="/channels" style={{ color: "var(--accent)" }}>
                  Channels, Try it
                </Link>
                .
              </>
            ) : (
              "Nothing matches those filters."
            )}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 150 }}>When</th>
                  <th style={{ width: 110 }}>Channel</th>
                  <th>Who and what</th>
                  <th style={{ width: 160 }}>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td className="mono muted" style={{ fontSize: 12 }}>
                      {new Date(r.at).toLocaleString()}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {r.channel}
                    </td>
                    <td>
                      <Link href={r.href} style={{ fontWeight: 600 }}>
                        {r.what}
                      </Link>
                      <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                        {r.who}
                        {r.detail ? ` · ${r.detail}` : ""}
                      </div>
                    </td>
                    <td style={{ fontSize: 12.5, color: r.tone === "warn" ? "var(--warn)" : undefined }}>
                      {r.outcome}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
