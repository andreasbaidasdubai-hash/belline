"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * The phone half of Go live, as one flow: get the number, forward the line,
 * prove it with a test call.
 *
 * Every code shown has the venue's real number in it and is a tel: link, so an
 * owner on their mobile taps it instead of typing asterisks. Nothing here says
 * forwarding works until the voice webhook has recorded the test call.
 */

export interface CarrierView {
  id: string;
  name: string;
  verified: boolean;
  landline: string | null;
}

export interface CodeView {
  when: string;
  meaning: string;
  dial: string;
  tel: string;
}

type Verify =
  | { state: "none" }
  | { state: "open"; expiresAt: string }
  | { state: "verified"; at: string }
  | { state: "expired"; failedWindows: number };

export default function PhoneSetup({
  locationId,
  number: initialNumber,
  poolOn,
  carriers,
  codes: initialCodes,
  pbxNote,
  diagnosis,
  unverifiedNote,
  codesExplained,
  phoneOptional,
  skipHref,
  verify: initialVerify,
}: {
  locationId: string;
  number: string;
  /** `numbers.pool`: a number can be claimed now rather than prepared by hand. */
  poolOn: boolean;
  carriers: CarrierView[];
  codes: CodeView[];
  pbxNote: string;
  diagnosis: { cause: string; check: string }[];
  unverifiedNote: string;
  /** forwarding.ts `CODES_EXPLAINED`: what the codes are, and that the owner dials them. */
  codesExplained: string;
  /** forwarding.ts `PHONE_OPTIONAL`. */
  phoneOptional: string;
  /** Where "Skip the phone for now" goes: the website chat, the other way in. */
  skipHref: string;
  verify: Verify;
}) {
  const [number, setNumber] = useState(initialNumber);
  const [codes, setCodes] = useState(initialCodes);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [carrier, setCarrier] = useState(carriers[0]?.id ?? "du");
  const [verify, setVerify] = useState<Verify>(initialVerify);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // While the window is open, ask every five seconds whether the call came.
  useEffect(() => {
    if (verify.state !== "open") return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/phone/verify?locationId=${encodeURIComponent(locationId)}`);
        if (res.ok) setVerify((await res.json()) as Verify);
      } catch {
        /* the next tick tries again */
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [verify.state, locationId]);

  async function getNumber() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/phone/number", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId }),
      });
      const data = (await res.json()) as { state?: string; number?: string; message?: string; ticket?: string; error?: string };
      if (!res.ok) setError(data.error ?? "That did not work. Try again in a moment.");
      else if (data.state === "assigned" && data.number) {
        // The codes need the number in them, and the server builds them, so reload once.
        setNumber(data.number);
        window.location.reload();
      } else setPreparing(`${data.message ?? "Your number is being prepared."}${data.ticket ? ` Ticket ${data.ticket}.` : ""}`);
    } catch {
      setError("That did not work. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  async function startTest() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/phone/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId, carrier }),
      });
      const data = (await res.json()) as Verify & { error?: string };
      if (!res.ok) setError(data.error ?? "That did not work. Try again in a moment.");
      else setVerify(data);
    } catch {
      setError("That did not work. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  // Never implied to be required. Hidden once forwarding is proven, when
  // there is nothing left to skip.
  const skip =
    verify.state === "verified" ? null : (
      <p className="muted" style={{ margin: "14px 0 0", fontSize: 13 }}>
        {phoneOptional}{" "}
        <Link href={skipHref} className="btn" style={{ padding: "6px 12px", fontSize: 12.5, marginLeft: 4 }}>
          Skip the phone for now
        </Link>
      </p>
    );

  if (!number) {
    return (
      <div>
        <p style={{ margin: "0 0 12px" }}>
          Every business gets its own Belline number to forward to, so a call reaches your diary and nobody else&apos;s.
        </p>
        {preparing || !poolOn ? (
          <p role="status" className="muted" style={{ margin: 0 }}>
            {preparing ?? "Your number is being prepared, usually within one working day. It appears here as soon as it is ready, and there is nothing you need to send."}
          </p>
        ) : (
          <button className="btn btn-accent" type="button" onClick={getNumber} disabled={busy}>
            {busy ? "Getting your number…" : "Get my number"}
          </button>
        )}
        {error && <p role="alert" style={{ color: "var(--bad)", fontSize: 12.5, margin: "10px 0 0" }}>{error}</p>}
        {skip}
      </div>
    );
  }

  const chosen = carriers.find((c) => c.id === carrier);
  // A number that cannot be dialled has no codes: say it is being prepared,
  // never show an empty table or a code with a gap in it.
  const mobile = Boolean(chosen) && codes.length > 0;

  return (
    <div>
      <p style={{ margin: "0 0 12px" }}>
        Your Belline number is <strong className="mono">{number}</strong>. Your team still gets first refusal: Belline only
        hears a call that rang out or found the line busy.
      </p>

      <div role="group" aria-label="Your phone line" style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 14px" }}>
        {[...carriers.map((c) => ({ id: c.id, name: `${c.name} mobile` })), { id: "landline", name: "Landline" }, { id: "pbx", name: "Office phone system" }].map((c) => (
          <button
            key={c.id}
            type="button"
            className={c.id === carrier ? "btn btn-accent" : "btn"}
            aria-pressed={c.id === carrier}
            onClick={() => setCarrier(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>

      {mobile ? (
        <>
          <p style={{ margin: "0 0 8px" }}>
            On the phone whose calls you want covered, tap a code and press call. Belline only hears the calls each
            code sends it.
          </p>
          <p className="muted" data-testid="codes-explained" style={{ margin: "0 0 10px", fontSize: 13 }}>
            {codesExplained}
          </p>
          <div className="table-wrap" tabIndex={0}>
            <table className="forward-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Tap to dial</th>
                </tr>
              </thead>
              <tbody>
                {codes.map((code) => (
                  <tr key={code.when}>
                    <td>
                      {code.when}
                      <span className="muted" style={{ display: "block", fontSize: 12.5 }}>
                        {code.meaning}
                      </span>
                    </td>
                    <td className="mono">
                      <a href={code.tel}>{code.dial}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {chosen && !chosen.verified && <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0" }}>{unverifiedNote}</p>}
        </>
      ) : chosen ? (
        <p role="status" className="muted" style={{ margin: 0 }}>
          The codes appear here with your Belline number in them as soon as the number is ready.
        </p>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          {carrier === "pbx"
            ? pbxNote
            : carriers
                .map((c) => c.landline)
                .filter(Boolean)
                .join(" ")}
        </p>
      )}

      <div style={{ marginTop: 18 }}>
        {verify.state === "verified" ? (
          <p role="status" style={{ margin: 0, color: "var(--ok)", fontWeight: 600 }}>
            Forwarding works. Your test call reached Belline.
          </p>
        ) : verify.state === "open" ? (
          <p role="status" style={{ margin: 0 }}>
            From any other phone, call your business number and let it ring out. This page updates when the call arrives.
          </p>
        ) : (
          <>
            {verify.state === "expired" && (
              <div role="status" style={{ marginBottom: 12 }}>
                <p style={{ margin: "0 0 6px", fontWeight: 600 }}>No test call arrived. The usual reasons:</p>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                  {diagnosis.map((d) => (
                    <li key={d.cause}>
                      <strong>{d.cause}.</strong> <span className="muted">{d.check}</span>
                    </li>
                  ))}
                </ul>
                {verify.failedWindows >= 2 && (
                  <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
                    The Belline team has been told and will contact you at the email address on your account.
                  </p>
                )}
              </div>
            )}
            <button className="btn btn-accent" type="button" onClick={startTest} disabled={busy}>
              {busy ? "Opening the test…" : verify.state === "expired" ? "Test it again" : "I've set it — test it"}
            </button>
          </>
        )}
        {error && <p role="alert" style={{ color: "var(--bad)", fontSize: 12.5, margin: "10px 0 0" }}>{error}</p>}
      </div>
      {skip}
    </div>
  );
}
