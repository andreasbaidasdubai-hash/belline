import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { listLeads } from "@/lib/store";
import { isWaitlistLead } from "@/lib/leads/waitlist";
import { MARKETS } from "@/lib/markets";

export const dynamic = "force-dynamic";

/**
 * People who asked us for a call.
 *
 * Deliberately separate from the outbound pipeline: these are inbound, they
 * arrived within the last few minutes, and the only thing that matters about
 * them is how fast somebody rings back. A list that mixes them with a thousand
 * scraped prospects buries the one kind of lead that goes cold in an hour.
 *
 * Ordered newest first and showing everything the form captured, so whoever
 * picks up the phone has the context without opening anything else.
 */

function ago(at: string): string {
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function Fact({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.08em" }}>
        {label}
      </div>
      <div style={{ fontSize: 13, marginTop: 2, wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}

export default async function EnquiriesPage() {
  const user = await requireUser();
  // The layout guards this too. Checked again here because a route handler or
  // a future refactor can move a page out from under a layout, and the cost of
  // the second check is nothing. On the tenant, not the role — `role === "owner"`
  // is true of every self-serve signup, so it refused nobody.
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const leads = listLeads();

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 22, margin: 0, fontWeight: 600 }}>Enquiries</h1>
        <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          People who asked for a call from the website, and the German pages&rsquo; waitlist (Germany, Austria,
          Switzerland; no phone number asked). Newest first — these go cold fast.
        </p>
      </div>

      {leads.length === 0 ? (
        <div className="panel" style={{ padding: "28px 24px" }}>
          <p style={{ margin: 0, fontSize: 14 }}>Nothing yet.</p>
          <p className="muted" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.6, maxWidth: "60ch" }}>
            The English landing page sends people to the checkout, and &ldquo;Email us&rdquo; goes to
            hello@belline.ai. The German pages&rsquo; waitlist posts to{" "}
            <span className="mono">/api/leads/waitlist</span>, and anything posted to{" "}
            <span className="mono">/api/leads</span> lands here too, with its domain checked for
            deliverability first.
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {leads.map((lead) => (
            <div key={lead.id} className="panel" style={{ padding: "18px 20px" }}>
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "baseline",
                  flexWrap: "wrap",
                  marginBottom: 14,
                }}
              >
                <span style={{ fontSize: 15.5, fontWeight: 600 }}>{lead.company}</span>
                <span className="muted" style={{ fontSize: 13 }}>{lead.name}</span>
                <span className="pill">{lead.status}</span>
                {isWaitlistLead(lead) && (
                  <span className="pill" title="Joined the waitlist on a German page. Belline is not open there yet.">
                    waitlist{lead.market ? ` · ${lead.market}` : ""}
                  </span>
                )}
                {lead.emailCheck.role && (
                  <span className="pill" title="A shared mailbox rather than a person">
                    shared mailbox
                  </span>
                )}
                {lead.emailCheck.mx === null && (
                  <span
                    className="pill"
                    title="We could not reach DNS when this arrived, so the domain was accepted unverified."
                    style={{ color: "var(--warn)", borderColor: "var(--warn)" }}
                  >
                    domain unverified
                  </span>
                )}
                <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
                  {ago(lead.createdAt)}
                </span>
              </div>

              <div style={{ display: "flex", gap: 22, flexWrap: "wrap", marginBottom: 12 }}>
                <a href={`mailto:${lead.email}`} style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {lead.email}
                </a>
                {/* The DACH waitlist asks for no phone number: no empty tel: link. */}
                {lead.phone && (
                  <a href={`tel:${lead.phone}`} style={{ fontSize: 13.5, fontWeight: 600 }}>
                    {lead.phone}
                  </a>
                )}
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))",
                  gap: 14,
                  paddingTop: 12,
                  borderTop: "1px solid var(--border-soft)",
                }}
              >
                <Fact label="Wants" value={lead.intent} />
                <Fact label="Trade" value={lead.vertical} />
                <Fact label="Country" value={lead.market ? MARKETS[lead.market].name : undefined} />
                <Fact label="Venues" value={lead.venues} />
                <Fact label="Calls a day" value={lead.callVolume} />
                <Fact label="Free" value={lead.availability} />
                <Fact label="Timezone" value={lead.timezone} />
                <Fact label="Website" value={lead.website} />
                <Fact label="Came from" value={lead.source} />
              </div>

              {lead.notes && (
                <p
                  style={{
                    fontSize: 13,
                    lineHeight: 1.6,
                    marginTop: 14,
                    paddingTop: 12,
                    borderTop: "1px solid var(--border-soft)",
                    marginBottom: 0,
                  }}
                >
                  {lead.notes}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
