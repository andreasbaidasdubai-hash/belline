"use client";

import { useRef, useState } from "react";
import PhoneField, { type PhoneFieldHandle } from "@/components/PhoneField";
import { COUNTRIES, normaliseOwnerPhone, readStoredPhone } from "@/lib/phone";

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

/**
 * The bottom of a step: its main button again, beside "Skip for now".
 *
 * The main button used to be only at the top, placed before the detail so a
 * phone shows it without scrolling. An owner who reads the step to the end
 * then found "Skip for now" and nothing else, and skipped a step they had just
 * filled in. The server page renders this row for steps whose button is a
 * link; these components render it themselves, because the button is theirs.
 */
export function SkipLink({ href }: { href: string }) {
  return (
    <>
      <a href={href} className="btn" style={{ padding: "12px 18px" }} data-testid="setup-skip">
        Skip for now
      </a>
      <span className="muted" style={{ fontSize: 12.5 }}>
        It stays on your checklist on Home.
      </span>
    </>
  );
}

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
  id: "requests" | "link" | "belline" | "google" | "outlook" | "calendly";
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
  skipHref,
}: {
  options: DestinationOption[];
  current?: string;
  currentLink?: string;
  requested: string[];
  partners: { id: string; name: string }[];
  /** A sentence about what just happened, such as coming back from Google. */
  notice?: string;
  /** Where "Skip for now" goes, when the step is not done yet. */
  skipHref?: string;
}) {
  const open = options.filter((o) => o.state === "available").map((o) => o.id as string);
  const initial = current === "requests" && currentLink ? "link" : current && open.includes(current) ? current : "requests";
  const [chosen, setChosen] = useState(initial);
  const [link, setLink] = useState(currentLink ?? "");
  const [partner, setPartner] = useState(partners[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
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

      <div className="setup-footer">
        <button type="button" className="btn btn-accent" onClick={run} disabled={busy} style={{ padding: "12px 22px" }}>
          {busy ? "Saving…" : "Use this"}
        </button>
        {skipHref && <SkipLink href={skipHref} />}
        <div style={{ flexBasis: "100%" }}>
          <Problem error={error} />
        </div>
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
  countryIso,
  initial,
  skipHref,
  stay = false,
  locationId,
  children,
}: {
  /** Shown under the answers and above the buttons, such as the rules that are always on. */
  children?: React.ReactNode;
  /** The venue these rules are for. Setup leaves it out: a new account has one. */
  locationId?: string;
  mode: "requests" | "belline";
  restaurant: boolean;
  country: string;
  /** The business's own market, the country every phone field starts on. */
  countryIso: string;
  initial: RulesInitial;
  /** On the setup step, before it is done: where "Skip for now" goes. */
  skipHref?: string;
  /**
   * Your business → Rules. The same form, saved where it is: no step to move
   * on to, so it says "Saved." instead. Until 2026-09-17 the dashboard linked
   * "Booking and escalation rules" into setup, and an owner changing one number
   * was dropped into onboarding and walked on to the next step.
   */
  stay?: boolean;
}) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const set = <K extends keyof RulesInitial>(k: K, value: RulesInitial[K]) => setV((s) => ({ ...s, [k]: value }));
  const transfer = useRef<PhoneFieldHandle | null>(null);
  const transferE164 = useRef<string>("");
  const notifyInput = useRef<HTMLInputElement | null>(null);
  const [notifyCountry, setNotifyCountry] = useState(() => (initial.notify.includes("@") ? countryIso : readStoredPhone(initial.notify, countryIso).country));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setSaved(false);
    // Numbers are checked at the field before anything is sent: red, the reason under it, focus on it.
    if (!transfer.current?.check()) return;
    let notify = v.notify.trim();
    if (mode === "requests" && notify && !notify.includes("@")) {
      const out = normaliseOwnerPhone(notify, notifyCountry);
      if (!out.ok) {
        setError({ message: `For WhatsApp alerts: ${out.reason}`, field: "notify" });
        notifyInput.current?.focus();
        return;
      }
      notify = out.e164;
    }
    setBusy(true);
    const rules =
      mode === "requests"
        ? {
            askFor: v.askFor ? [restaurant ? "partySize" : "service"] : [],
            transferNumber: transferE164.current,
            notify,
            afterHours: v.afterHours,
            neverSay: v.neverSay,
          }
        : { transferNumber: transferE164.current };
    const out = await send({ action: "rules", rules, ...(locationId ? { locationId } : {}) });
    if (out.error) {
      setError({ message: out.error, field: out.field });
      setBusy(false);
      return;
    }
    if (stay) {
      setBusy(false);
      setSaved(true);
      return;
    }
    go(out.next);
  }

  const label = busy ? "Saving…" : stay ? "Save rules" : "Confirm these rules";

  const fieldError = (name: string) =>
    error?.field === name ? <Problem id={`${name}-error`} error={error.message} /> : null;
  const invalid = (name: string) => (error?.field === name ? { "aria-invalid": true, "aria-describedby": `${name}-error` } : {});

  return (
    <form onSubmit={submit} noValidate>
      {/* On the dashboard the one button is at the bottom, under the answers it saves. */}
      {!stay && (
        <button type="submit" className="btn btn-accent" disabled={busy} style={{ padding: "12px 22px" }}>
          {label}
        </button>
      )}
      {error && !error.field && !stay && <Problem error={error.message} />}

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

        <PhoneField
          ref={transfer}
          id="transfer-number"
          label="Number for urgent calls"
          value={initial.transferNumber}
          defaultCountry={countryIso}
          hint={<>On the Growth and Scale plans, Belline puts urgent calls through to this number live. It has to be a number in {country}, with its country code.</>}
          serverError={error?.field === "transferNumber" ? error.message : undefined}
          onValue={(p) => {
            transferE164.current = p.e164;
            if (error?.field === "transferNumber") setError(null);
          }}
        />

        {mode === "requests" && (
          <>
            <div>
              <label htmlFor="notify" style={{ textTransform: "none", letterSpacing: 0, fontSize: 14 }}>
                Your own email or WhatsApp, for new requests
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  aria-label="Country code"
                  value={notifyCountry}
                  onChange={(e) => setNotifyCountry(e.target.value)}
                  style={{ width: "auto", maxWidth: 150, flex: "0 0 auto" }}
                  title="Used when this is a WhatsApp number"
                >
                  {COUNTRIES.map((c) => (
                    <option key={c.iso} value={c.iso}>
                      {c.iso} +{c.dial}
                    </option>
                  ))}
                </select>
                <input
                  ref={notifyInput}
                  id="notify"
                  type="text"
                  autoComplete="email"
                  value={v.notify}
                  onChange={(e) => set("notify", e.target.value)}
                  {...invalid("notify")}
                  style={{ flex: 1, minWidth: 0, ...(error?.field === "notify" ? { borderColor: "var(--bad)" } : {}) }}
                />
              </div>
              <p className="muted" style={hint}>
                Your own email address or your own WhatsApp number (the country code beside it is used for a number), where Belline tells you about a new request. This is not
                Belline&apos;s WhatsApp and customers never see it. Requests always appear in your Inbox. Email and WhatsApp alerts
                are being prepared, and will go here when they are ready.
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

      {children}

      <div className="setup-footer">
        <button type="submit" className="btn btn-accent" disabled={busy} style={{ padding: "12px 22px" }}>
          {label}
        </button>
        {stay && error && !error.field && <Problem error={error.message} />}
        {stay && saved && (
          <span role="status" style={{ fontSize: 13.5, color: "var(--ok)" }}>
            Saved. Belline follows these from the next call and chat.
          </span>
        )}
        {skipHref && <SkipLink href={skipHref} />}
      </div>
    </form>
  );
}
