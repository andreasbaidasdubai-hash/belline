import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { listCalls } from "@/lib/store";
import { readiness } from "@/lib/onboarding";
import { raiseException } from "@/lib/errors/customer";
import { openException } from "@/lib/exceptions";
import { lapseSentence, serviceState } from "@/lib/billing/entitlement";
import { todayIn } from "@/lib/time";
import { flag } from "@/lib/flags";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import { CODES_EXPLAINED, DIAGNOSIS, PBX_NOTE, PHONE_OPTIONAL, UNVERIFIED_NOTE, forwardingCodes, uaeCarriers } from "@/lib/telephony/forwarding";
import { verificationState } from "@/lib/telephony/verify";
import PhoneSetup from "./PhoneSetup";

export const dynamic = "force-dynamic";

/**
 * From "set up" to "answering my phone".
 *
 * The website's step two says "point your line at it", and until this page
 * nothing in the product said *at what*, or how. Now it is one flow: get a
 * Belline number, forward the line to it with codes that already contain the
 * number, and prove it with a test call the server actually receives.
 *
 * The forwarding codes are the GSM supplementary-service codes, which work on
 * most mobile lines. Landlines and office phone systems each do it their own
 * way, and saying so is better than printing a code that does nothing.
 */

function Step({ n, title, done, optional, children }: { n: number; title: string; done: boolean; optional?: boolean; children: React.ReactNode }) {
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-head" style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span className="mono muted">0{n}</span>
        {title}
        <span className="pill" style={{ marginLeft: "auto", color: done ? "var(--good)" : "var(--text-2)" }}>
          {done ? "done" : optional ? "optional" : "to do"}
        </span>
      </div>
      <div style={{ padding: "16px 18px", fontSize: 13.5, lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

export default async function GoLivePage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string; from?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc, from } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const setup = readiness(location);
  const number = location.phone.trim();
  const dial = number.replace(/[^\d+]/g, "");
  const abroad = Boolean(dial) && !/^\+?971/.test(dial);
  const service = serviceState(location, todayIn(location.timezone));
  const phoneCalls = listCalls(location.id).filter((c) => c.channel === "phone" && !c.isDemo);
  const lastCall = phoneCalls.reduce<string | null>((a, c) => (!a || c.startedAt > a ? c.startedAt : a), null);
  const poolOn = flag("numbers.pool");
  const verify = verificationState(location);

  // With the pool off, numbers are assigned by the Belline team. Said as it
  // is, and the team is told, instead of a mailto the owner has to remember to
  // send. With it on, the owner presses "Get my number" and the ticket is only
  // opened if the pool turns out to be empty.
  if (!number && !poolOn) {
    raiseException(`numbers:unassigned:${location.id}`, `venue ${location.id} opened Go live without a number`);
    // One open row per venue: opening this page again only counts it.
    openException({
      tenantId: location.tenantId,
      locationId: location.id,
      kind: "pool_empty",
      reason: "Opened Go live without a Belline number. Numbers are assigned by hand until the pool is switched on.",
      source: "system",
    });
  }

  const verified = verify.state === "verified";

  return (
    <>
      <PageHeader
        title="Go live"
        subtitle="How Belline answers your real phone, if you want it to. Your customers keep dialling the number they already have, and nothing is forwarded until you dial a code yourself."
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
            <p style={{ margin: "0 0 8px" }}>
              Without these it answers, but it cannot book or answer properly. Quickest:{" "}
              <Link href={`/setup/assistant?loc=${location.id}`}>set it up by talking to Belle</Link>.
            </p>
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

      <Step n={2} title="Your number, and forwarding to it" done={verified} optional>
        <PhoneSetup
          locationId={location.id}
          number={number}
          poolOn={poolOn}
          carriers={uaeCarriers(number).map((c) => ({ id: c.id, name: c.name, verified: c.verified, landline: c.landline }))}
          codes={forwardingCodes(number).map(({ when, meaning, dial: code, tel }) => ({ when, meaning, dial: code, tel }))}
          pbxNote={PBX_NOTE}
          diagnosis={DIAGNOSIS}
          unverifiedNote={UNVERIFIED_NOTE}
          codesExplained={CODES_EXPLAINED}
          phoneOptional={PHONE_OPTIONAL}
          skipHref={from === "setup" ? "/website?from=setup" : `/website?loc=${location.id}`}
          verify={verify}
        />
        {abroad && (
          <p style={{ margin: "10px 0 0", color: "var(--warn)" }}>
            This number is outside the UAE. Your phone provider charges a forwarded call like a call you
            make to that country, so check their rate before you switch forwarding on.
          </p>
        )}
      </Step>

      <Step n={3} title="Real calls arriving" done={phoneCalls.length > 0}>
        {phoneCalls.length > 0 ? (
          <p style={{ margin: 0 }}>
            Calls are arriving — the last one was {lastCall?.slice(0, 16).replace("T", " ")}.{" "}
            <Link href={`/calls?loc=${location.id}`}>See the calls</Link>
          </p>
        ) : (
          <p style={{ margin: 0 }}>
            Once forwarding works, every call your team misses is answered as {location.name}. Before that, the{" "}
            <Link href={`/test?loc=${location.id}`}>test console</Link> costs nothing.
          </p>
        )}
      </Step>
    </>
  );
}
