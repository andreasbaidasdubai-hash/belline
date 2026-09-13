import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { listCalls } from "@/lib/store";
import { readiness } from "@/lib/onboarding";
import { lapseSentence, serviceState } from "@/lib/billing/entitlement";
import { todayIn } from "@/lib/time";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";

export const dynamic = "force-dynamic";

/**
 * From "set up" to "answering my phone".
 *
 * The website's step two says "point your line at it", and until this page
 * nothing in the product said *at what*, or how. Setup ended on "Belline is
 * ready" for a venue with no number anybody could forward to — the one step
 * between a trial and a real call was a conversation that had not happened.
 *
 * The forwarding codes are the GSM supplementary-service codes, which work on
 * most mobile lines. Landlines and office phone systems each do it their own
 * way, and saying so is better than printing a code that does nothing.
 */

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-head" style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span className="mono muted">0{n}</span>
        {title}
        <span className="pill" style={{ marginLeft: "auto", color: done ? "var(--good)" : "var(--text-2)" }}>
          {done ? "done" : "to do"}
        </span>
      </div>
      <div style={{ padding: "16px 18px", fontSize: 13.5, lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

export default async function GoLivePage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const setup = readiness(location);
  const number = location.phone.trim();
  const dial = number.replace(/[^\d+]/g, "");
  const abroad = Boolean(dial) && !/^\+?971/.test(dial);
  const service = serviceState(location, todayIn(location.timezone));
  const phoneCalls = listCalls(location.id).filter((c) => c.channel === "phone" && !c.isDemo);
  const lastCall = phoneCalls.reduce<string | null>((a, c) => (!a || c.startedAt > a ? c.startedAt : a), null);
  const target = dial || "<your Belline number>";

  const request = `mailto:hello@belline.ai?subject=${encodeURIComponent(
    `Belline number for ${location.name}`,
  )}&body=${encodeURIComponent(`Please assign a Belline number to ${location.name} (venue ${location.id}).`)}`;

  return (
    <>
      <PageHeader
        title="Go live"
        subtitle="Four steps between a finished setup and Belline answering your real phone. Your customers keep dialling the number they already have."
      />
      <LocationTabs base="/golive" active={location.id} />

      {service.lapsed && (
        <div className="panel" style={{ padding: "15px 18px", marginBottom: 14, borderColor: "var(--bad)", background: "var(--bad-soft)" }}>
          <strong style={{ color: "var(--bad)", fontSize: 13.5 }}>{lapseSentence(service.lapsed, !service.answering)}</strong>{" "}
          <Link href="/checkout" style={{ fontSize: 13 }}>Choose a plan</Link>
        </div>
      )}

      <Step n={1} title="Finish what Belline needs to know" done={setup.ready}>
        {setup.ready ? (
          <p style={{ margin: 0 }}>Services, people and common questions are in. You can change any of it later.</p>
        ) : (
          <>
            <p style={{ margin: "0 0 8px" }}>Without these it answers, but it cannot book or answer properly:</p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {setup.missing.map((m) => (
                <li key={m.label}>
                  <Link href={`${m.where}?loc=${location.id}`}>{m.label}</Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Step>

      <Step n={2} title="Your Belline number" done={Boolean(number)}>
        {number ? (
          <>
            <p style={{ margin: 0 }}>
              Calls forwarded to <strong className="mono">{number}</strong> are answered as {location.name}.
              Nobody needs to know this number — it is only where your own line sends the calls it cannot take.
            </p>
            {abroad && (
              <p style={{ margin: "10px 0 0", color: "var(--warn)" }}>
                This number is outside the UAE. Your phone provider charges a forwarded call like a call you
                make to that country, so check their rate before you switch forwarding on.
              </p>
            )}
          </>
        ) : (
          <>
            <p style={{ margin: 0 }}>
              Every venue gets its own number to forward to, so a call reaches your diary and not somebody
              else&apos;s. Yours has not been assigned yet.
            </p>
            <a className="btn btn-accent" href={request} style={{ marginTop: 12, display: "inline-block" }}>
              Ask for my number
            </a>
          </>
        )}
      </Step>

      <Step n={3} title="Forward the calls nobody picks up" done={phoneCalls.length > 0}>
        <p style={{ margin: "0 0 12px" }}>
          On most mobile lines, dial each code from the phone whose calls you want covered and press call.
          Your team still gets first refusal: Belline only hears a call that rang out or found the line busy.
        </p>
        <div className="table-wrap" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Dial</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Nobody answers</td><td className="mono">**61*{target}#</td></tr>
              <tr><td>The line is busy</td><td className="mono">**67*{target}#</td></tr>
              <tr><td>The phone is off or out of signal</td><td className="mono">**62*{target}#</td></tr>
              <tr><td>Switch all of it off again</td><td className="mono">##004#</td></tr>
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ margin: "12px 0 0", fontSize: 12.5 }}>
          A landline or an office phone system sets this up differently. Ask your provider, or whoever
          looks after the system, for conditional forwarding on <em>no answer</em> and <em>busy</em> to the number above.
        </p>
      </Step>

      <Step n={4} title="Ring it yourself" done={phoneCalls.length > 0}>
        {phoneCalls.length > 0 ? (
          <p style={{ margin: 0 }}>
            Calls are arriving — the last one was {lastCall?.slice(0, 16).replace("T", " ")}.{" "}
            <Link href={`/calls?loc=${location.id}`}>See the calls</Link>
          </p>
        ) : (
          <p style={{ margin: 0 }}>
            From a different phone, ring your usual number and let it ring out. Belline should pick up as{" "}
            {location.name}. Book something, then check it appears in <Link href={`/bookings?loc=${location.id}`}>Bookings</Link>.
            Before that, the <Link href={`/test?loc=${location.id}`}>test console</Link> costs nothing.
          </p>
        )}
      </Step>
    </>
  );
}
