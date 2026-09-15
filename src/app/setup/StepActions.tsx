"use client";

import { useState } from "react";

/**
 * The buttons and small forms on the setup steps.
 *
 * Each sends one action to /api/setup/journey and follows the step the server
 * says is next. The server re-checks everything, Go live included, so these
 * are conveniences, not the gate.
 */

type Reply = { next?: string; error?: string; fix?: string; field?: string; requested?: string[] };

async function send(body: Record<string, unknown>): Promise<Reply> {
  try {
    const res = await fetch("/api/setup/journey", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Reply;
    if (!res.ok) return { error: data.error ?? "That did not save. Try again.", fix: data.fix, field: data.field };
    return { next: data.next, requested: data.requested };
  } catch {
    return { error: "Could not reach Belline. Check your connection and try again." };
  }
}

function go(next: string | undefined) {
  window.location.href = next?.startsWith("/") && !next.startsWith("//") ? next : "/setup";
}

function Problem({ error, fix, id }: { error: string | null; fix?: string; id?: string }) {
  if (!error) return null;
  return (
    <p id={id} role="alert" style={{ fontSize: 13.5, color: "var(--bad)", margin: "8px 0 0" }}>
      {error} {fix && <a href={fix}>Fix this</a>}
    </p>
  );
}

const hint = { fontSize: 12.5, lineHeight: 1.5, margin: "4px 0 0" } as const;

export function ActionButton({ action, label }: { action: "rules" | "activate"; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fix, setFix] = useState<string | undefined>();

  async function run() {
    setBusy(true);
    setError(null);
    const out = await send({ action });
    if (out.error) {
      setError(out.error);
      setFix(out.fix);
      setBusy(false);
      return;
    }
    go(out.next);
  }

  return (
    <div>
      <button type="button" className="btn btn-accent" onClick={run} disabled={busy} style={{ padding: "12px 22px" }}>
        {busy ? "Saving…" : label}
      </button>
      <Problem error={error} fix={fix} />
    </div>
  );
}

/**
 * "Tell me when it's ready". Records interest in a system Belline cannot
 * connect to yet, and says exactly that: nothing is connected.
 */
export function RequestIntegration({ id, name, label, requested }: { id: string; name: string; label?: string; requested: boolean }) {
  const [done, setDone] = useState(requested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const out = await send({ action: "integration", integration: id });
    setBusy(false);
    if (out.error) setError(out.error);
    else setDone(true);
  }

  if (done) {
    return (
      <p role="status" style={{ ...hint, color: "var(--text)" }}>
        Noted. We&apos;ll let you know when {name} is ready.
      </p>
    );
  }
  return (
    <div>
      <button type="button" className="btn" onClick={run} disabled={busy} style={{ padding: "6px 12px", fontSize: 13, marginTop: 8 }}>
        {busy ? "Saving…" : (label ?? `Request ${name}`)}
      </button>
      <Problem error={error} />
    </div>
  );
}

export interface DestinationOption {
  id: "requests" | "link" | "belline" | "google" | "outlook";
  title: string;
  body: string;
  /** "connect": the option works once the owner connects an account at `connectUrl`. */
  state: "available" | "preparing" | "soon" | "connect";
  connectUrl?: string;
}

const STATE_LABEL: Record<DestinationOption["state"], string> = {
  available: "Available",
  preparing: "Being prepared",
  soon: "Coming soon",
  connect: "Connect first",
};

export function DestinationPicker({
  options,
  current,
  currentLink,
  requested,
  partners,
  notice,
}: {
  options: DestinationOption[];
  current?: string;
  currentLink?: string;
  requested: string[];
  partners: { id: string; name: string }[];
  /** A sentence about what just happened, such as coming back from Google. */
  notice?: string;
}) {
  const open = options.filter((o) => o.state === "available").map((o) => o.id as string);
  const initial = current === "requests" && currentLink ? "link" : current && open.includes(current) ? current : "requests";
  const [chosen, setChosen] = useState(initial);
  const [link, setLink] = useState(currentLink ?? "");
  const [partner, setPartner] = useState(partners[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    if (chosen === "link" && !link.trim()) {
      setError("Paste your booking link first.");
      return;
    }
    setBusy(true);
    const out = await send({
      action: "destination",
      destination: chosen === "link" ? "requests" : chosen,
      ...(chosen === "link" ? { bookingLink: link } : {}),
    });
    if (out.error) {
      setError(out.error);
      setBusy(false);
      return;
    }
    go(out.next);
  }

  const partnerName = partners.find((p) => p.id === partner)?.name ?? "";

  return (
    <div>
      {notice && (
        <p role="status" style={{ fontSize: 14, lineHeight: 1.5, margin: "0 0 14px" }}>
          {notice}
        </p>
      )}
      <button type="button" className="btn btn-accent" onClick={run} disabled={busy} style={{ padding: "12px 22px" }}>
        {busy ? "Saving…" : "Use this"}
      </button>
      <Problem error={error} />

      <fieldset style={{ border: 0, padding: 0, margin: "22px 0 0", display: "grid", gap: 10 }}>
        <legend className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
          Where Belline puts a booking
        </legend>
        {options.map((o) => {
          const available = o.state === "available";
          return (
            <div
              key={o.id}
              style={{
                padding: "14px 16px",
                border: `1px solid ${chosen === o.id ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 12,
                background: "var(--panel)",
              }}
            >
              <label style={{ display: "flex", gap: 12, alignItems: "flex-start", textTransform: "none", letterSpacing: 0, opacity: available ? 1 : 0.8, cursor: available ? "pointer" : "default" }}>
                <input
                  type="radio"
                  name="destination"
                  value={o.id}
                  checked={chosen === o.id}
                  disabled={!available}
                  onChange={() => setChosen(o.id)}
                  style={{ width: "auto", marginTop: 3 }}
                />
                <span style={{ display: "grid", gap: 4 }}>
                  <span style={{ fontSize: 14.5, fontWeight: 600 }}>
                    {o.title}{" "}
                    <span className="pill" style={{ fontWeight: 400, marginLeft: 6 }}>
                      {STATE_LABEL[o.state]}
                    </span>
                  </span>
                  <span className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
                    {o.body}
                  </span>
                </span>
              </label>
              {o.id === "link" && chosen === "link" && (
                <div style={{ marginTop: 10, paddingLeft: 28 }}>
                  <label htmlFor="booking-link" style={{ fontSize: 13, textTransform: "none", letterSpacing: 0 }}>
                    Your booking link
                  </label>
                  <input id="booking-link" type="url" inputMode="url" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} />
                </div>
              )}
              {o.state === "connect" && o.connectUrl && (
                <div style={{ paddingLeft: 28, marginTop: 8 }}>
                  <a className="btn" href={o.connectUrl} style={{ padding: "6px 12px", fontSize: 13 }}>
                    Connect {o.title}
                  </a>
                </div>
              )}
              {(o.id === "google" || o.id === "outlook") && (o.state === "soon" || o.state === "preparing") && (
                <div style={{ paddingLeft: 28 }}>
                  <RequestIntegration id={o.id} name={o.title} label="Tell me when it's ready" requested={requested.includes(o.id)} />
                </div>
              )}
            </div>
          );
        })}
      </fieldset>

      <div className="panel" style={{ padding: "14px 16px", marginTop: 16 }}>
        <label htmlFor="partner" style={{ fontSize: 14, fontWeight: 600, textTransform: "none", letterSpacing: 0 }}>
          Already use a booking system?
        </label>
        <p className="muted" style={hint}>
          Belline cannot connect to these yet. Start with requests, and ask for yours so we know which to build first.
        </p>
        <select id="partner" value={partner} onChange={(e) => setPartner(e.target.value)} style={{ marginTop: 8 }}>
          {partners.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <RequestIntegration key={partner} id={partner} name={partnerName} requested={requested.includes(partner)} />
      </div>
    </div>
  );
}

export interface RulesInitial {
  askFor: boolean;
  transferNumber: string;
  notify: string;
  afterHours: "request" | "message";
  neverSay: string;
}

/**
 * The rules step, in five inputs at most. Everything is optional except that
 * a number, if given, is one Belline may dial.
 */
export function RulesForm({
  mode,
  restaurant,
  country,
  initial,
}: {
  mode: "requests" | "belline";
  restaurant: boolean;
  country: string;
  initial: RulesInitial;
}) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const set = <K extends keyof RulesInitial>(k: K, value: RulesInitial[K]) => setV((s) => ({ ...s, [k]: value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const rules =
      mode === "requests"
        ? {
            askFor: v.askFor ? [restaurant ? "partySize" : "service"] : [],
            transferNumber: v.transferNumber,
            notify: v.notify,
            afterHours: v.afterHours,
            neverSay: v.neverSay,
          }
        : { transferNumber: v.transferNumber };
    const out = await send({ action: "rules", rules });
    if (out.error) {
      setError({ message: out.error, field: out.field });
      setBusy(false);
      return;
    }
    go(out.next);
  }

  const fieldError = (name: string) =>
    error?.field === name ? <Problem id={`${name}-error`} error={error.message} /> : null;
  const invalid = (name: string) => (error?.field === name ? { "aria-invalid": true, "aria-describedby": `${name}-error` } : {});

  return (
    <form onSubmit={submit} noValidate>
      <button type="submit" className="btn btn-accent" disabled={busy} style={{ padding: "12px 22px" }}>
        {busy ? "Saving…" : "Confirm these rules"}
      </button>
      {error && !error.field && <Problem error={error.message} />}

      <div style={{ display: "grid", gap: 18, marginTop: 22, maxWidth: 520 }}>
        {mode === "requests" && (
          <div>
            <p className="muted" style={{ ...hint, marginTop: 0 }}>
              Belline always asks for a name and a contact number.
            </p>
            <label style={{ display: "flex", gap: 10, alignItems: "center", textTransform: "none", letterSpacing: 0, fontSize: 14, marginTop: 6 }}>
              <input type="checkbox" checked={v.askFor} onChange={(e) => set("askFor", e.target.checked)} style={{ width: "auto" }} />
              {restaurant ? "Also ask how many people it is for" : "Also ask what they would like to book"}
            </label>
          </div>
        )}

        <div>
          <label htmlFor="transfer-number" style={{ textTransform: "none", letterSpacing: 0, fontSize: 14 }}>
            Number for urgent calls
          </label>
          <input
            id="transfer-number"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={v.transferNumber}
            onChange={(e) => set("transferNumber", e.target.value)}
            {...invalid("transferNumber")}
          />
          <p className="muted" style={hint}>
            Belline puts urgent calls through to this number. It has to be a number in {country}.
          </p>
          {fieldError("transferNumber")}
        </div>

        {mode === "requests" && (
          <>
            <div>
              <label htmlFor="notify" style={{ textTransform: "none", letterSpacing: 0, fontSize: 14 }}>
                Where to tell you about new requests
              </label>
              <input id="notify" type="text" autoComplete="email" value={v.notify} onChange={(e) => set("notify", e.target.value)} {...invalid("notify")} />
              <p className="muted" style={hint}>
                An email address or a WhatsApp number. Requests always appear in your Inbox. Email and WhatsApp alerts are being
                prepared, and will go here when they are ready.
              </p>
              {fieldError("notify")}
            </div>

            <div>
              <label htmlFor="after-hours" style={{ textTransform: "none", letterSpacing: 0, fontSize: 14 }}>
                When you are closed
              </label>
              <select id="after-hours" value={v.afterHours} onChange={(e) => set("afterHours", e.target.value === "message" ? "message" : "request")}>
                <option value="request">Take booking requests as usual</option>
                <option value="message">Take a message instead</option>
              </select>
            </div>

            <div>
              <label htmlFor="never-say" style={{ textTransform: "none", letterSpacing: 0, fontSize: 14 }}>
                Anything Belline must never say
              </label>
              <textarea id="never-say" rows={3} value={v.neverSay} onChange={(e) => set("neverSay", e.target.value)} {...invalid("neverSay")} />
              <p className="muted" style={hint}>
                One per line. For example: never promise a window seat.
              </p>
              {fieldError("neverSay")}
            </div>
          </>
        )}
      </div>
    </form>
  );
}
