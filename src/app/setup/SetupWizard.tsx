"use client";

import { useState } from "react";
import type { Vertical } from "@/lib/types";

/**
 * Setup as a conversation.
 *
 * The form this replaces would have asked for an address, opening hours, a
 * price list, a staff list and eight FAQs — perhaps forty fields, typed by
 * somebody who already published all of it on their own website.
 *
 * So: paste the website, Belline reads it, and the only things asked are the
 * ones the page did not answer. On a typical salon site that is two questions
 * instead of forty.
 *
 * Everything shown is editable before it is saved, and nothing is live until
 * the owner presses the button. That is not politeness — the reader is a model
 * looking at a public web page, and it is wrong often enough that an
 * unreviewed price would otherwise be quoted to a real customer on a real
 * call.
 */

interface Draft {
  found: {
    name: string;
    vertical: Vertical;
    address: string;
    timezone: string;
    greeting: string;
    services: { name: string; durationMin: number; price: number }[];
    staff: string[];
    faqs: { q: string; a: string }[];
  };
  sourceUrl: string;
  gaps: { field: string; question: string; why: string }[];
}

type Stage = "ask" | "reading" | "review" | "saving" | "done";

export default function SetupWizard({
  venueName,
  vertical,
  alreadyReady,
  missing,
}: {
  venueName: string;
  vertical: Vertical;
  alreadyReady: boolean;
  missing: { label: string; where: string }[];
}) {
  const [stage, setStage] = useState<Stage>(alreadyReady ? "done" : "ask");
  const [website, setWebsite] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  async function read(event: React.FormEvent) {
    event.preventDefault();
    if (!website.trim()) return;
    setStage("reading");
    setError(null);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ website }),
      });
      const body = (await res.json()) as { ok?: boolean; draft?: Draft; error?: string };
      if (!res.ok || !body.draft) {
        setError(body.error ?? "Could not read that page.");
        setStage("ask");
        return;
      }
      setDraft(body.draft);
      setStage("review");
    } catch {
      setError("Could not reach that address.");
      setStage("ask");
    }
  }

  async function save() {
    if (!draft) return;
    setStage("saving");
    try {
      const res = await fetch("/api/setup", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          website: draft.sourceUrl,
          name: draft.found.name,
          address: answers.address || draft.found.address,
          phone: answers.phone,
          greeting: draft.found.greeting,
          services: draft.found.services,
          staff: draft.found.staff,
          faqs: draft.found.faqs,
          policies: answers.policies
            ? answers.policies.split("\n").map((s) => s.trim()).filter(Boolean)
            : undefined,
        }),
      });
      if (!res.ok) {
        setError("Could not save that. Try again.");
        setStage("review");
        return;
      }
      setStage("done");
    } catch {
      setError("Could not save that. Try again.");
      setStage("review");
    }
  }

  const serif = { fontFamily: '"Fraunces", Georgia, serif', fontWeight: 500 } as const;

  // ---- done ---------------------------------------------------------------

  if (stage === "done") {
    return (
      <div>
        <h1 style={{ ...serif, fontSize: 34, letterSpacing: "-0.02em", lineHeight: 1.1, margin: "0 0 14px" }}>
          {alreadyReady ? "Belline is ready." : "That's the hard part done."}
        </h1>
        <p style={{ color: "var(--text-2)", fontSize: 16, lineHeight: 1.6, maxWidth: "54ch" }}>
          {missing.length
            ? "A few things are still worth filling in before it answers a real customer."
            : "Try it now — ring it, or open the test console and talk to it."}
        </p>

        {missing.length > 0 && (
          <ul style={{ margin: "18px 0 0", paddingLeft: 20, color: "var(--text-2)", fontSize: 14.5 }}>
            {missing.map((m) => (
              <li key={m.label} style={{ marginBottom: 6 }}>
                {m.label} — <a href={m.where}>add it</a>
              </li>
            ))}
          </ul>
        )}

        <div style={{ display: "flex", gap: 12, marginTop: 30, flexWrap: "wrap" }}>
          <a className="btn btn-accent" href="/test" style={{ padding: "12px 20px" }}>
            Talk to {venueName}
          </a>
          <a className="btn" href="/" style={{ padding: "12px 20px" }}>
            Open the dashboard
          </a>
        </div>

        {/*
          The card, offered rather than demanded. They are inside the product
          on a trial that is already answering — asking for it before they have
          heard it work would have been the easier sale and the worse one.
        */}
        <p className="muted" style={{ fontSize: 12.5, marginTop: 26, lineHeight: 1.6 }}>
          Your first fortnight is free. <a href="/checkout">Add a card</a> whenever you are
          ready — nothing stops working before then.
        </p>
      </div>
    );
  }

  // ---- review -------------------------------------------------------------

  if ((stage === "review" || stage === "saving") && draft) {
    const f = draft.found;
    return (
      <div>
        <p className="muted" style={{ fontSize: 11.5, letterSpacing: "0.16em", textTransform: "uppercase", margin: "0 0 14px", color: "var(--gold-ink)" }}>
          Step 2 of 2
        </p>
        <h1 style={{ ...serif, fontSize: 32, letterSpacing: "-0.02em", lineHeight: 1.12, margin: "0 0 14px" }}>
          Here's what I understood.
        </h1>
        <p style={{ color: "var(--text-2)", fontSize: 15.5, lineHeight: 1.6, maxWidth: "56ch" }}>
          Read from {new URL(draft.sourceUrl).hostname}. Change anything that is
          wrong — Belline will say exactly what is on this screen, so a price
          that is out of date here is a price a customer gets told.
        </p>

        <div style={{ marginTop: 28, borderTop: "1px solid var(--border)" }}>
          <Row label="Business">{f.name}</Row>
          <Row label="Answers with">“{f.greeting}”</Row>
          {f.address && <Row label="Address">{f.address}</Row>}

          {f.services.length > 0 && (
            <Row label={vertical === "restaurant" ? "On the menu" : "What you offer"}>
              <div style={{ display: "grid", gap: 4 }}>
                {f.services.map((s) => (
                  <div key={s.name} style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <span>{s.name}</span>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {s.durationMin} min
                      {s.price ? ` · ${s.price}` : " · no price on your site"}
                    </span>
                  </div>
                ))}
              </div>
            </Row>
          )}

          {f.staff.length > 0 && <Row label="Who works there">{f.staff.join(", ")}</Row>}

          {f.faqs.length > 0 && (
            <Row label="It can already answer">
              <div style={{ display: "grid", gap: 6 }}>
                {f.faqs.map((q) => (
                  <div key={q.q} style={{ fontSize: 14 }}>
                    {q.q}
                  </div>
                ))}
              </div>
            </Row>
          )}
        </div>

        {draft.gaps.length > 0 && (
          <>
            <h2 style={{ ...serif, fontSize: 22, letterSpacing: "-0.015em", margin: "36px 0 6px" }}>
              {draft.gaps.length === 1 ? "One thing your site doesn't say." : `${draft.gaps.length} things your site doesn't say.`}
            </h2>
            <p className="muted" style={{ fontSize: 13.5, margin: "0 0 20px" }}>
              Skip any of them — you can add them later, and Belline will say it
              does not know rather than guess.
            </p>

            <div style={{ display: "grid", gap: 20 }}>
              {draft.gaps.map((gap) => (
                <div key={gap.field}>
                  <label htmlFor={`gap-${gap.field}`} style={{ textTransform: "none", letterSpacing: 0, fontSize: 14, fontWeight: 600 }}>
                    {gap.question}
                  </label>
                  <p className="muted" style={{ fontSize: 12, margin: "2px 0 8px" }}>
                    {gap.why}
                  </p>
                  <textarea
                    id={`gap-${gap.field}`}
                    rows={gap.field === "policies" || gap.field === "services" ? 3 : 2}
                    value={answers[gap.field] ?? ""}
                    onChange={(e) => setAnswers({ ...answers, [gap.field]: e.target.value })}
                  />
                </div>
              ))}
            </div>
          </>
        )}

        {error && (
          <p role="alert" style={{ marginTop: 20, fontSize: 13, color: "var(--bad)" }}>
            {error}
          </p>
        )}

        <div style={{ display: "flex", gap: 12, marginTop: 32, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn btn-accent" onClick={save} disabled={stage === "saving"} style={{ padding: "12px 22px" }}>
            {stage === "saving" ? "Saving…" : "That's right — save it"}
          </button>
          <button
            className="btn"
            onClick={() => {
              setDraft(null);
              setStage("ask");
            }}
            style={{ padding: "12px 18px" }}
          >
            Try a different page
          </button>
        </div>
      </div>
    );
  }

  // ---- ask ----------------------------------------------------------------

  return (
    <div>
      <p className="muted" style={{ fontSize: 11.5, letterSpacing: "0.16em", textTransform: "uppercase", margin: "0 0 14px", color: "var(--gold-ink)" }}>
        Step 1 of 2
      </p>
      <h1 style={{ ...serif, fontSize: 34, letterSpacing: "-0.02em", lineHeight: 1.1, margin: "0 0 14px" }}>
        What's your website?
      </h1>
      <p style={{ color: "var(--text-2)", fontSize: 16, lineHeight: 1.6, maxWidth: "54ch" }}>
        Belline will read it and set itself up — your services, your hours, your
        prices, the questions people ask. You check it on the next screen before
        anything goes live.
      </p>

      <form onSubmit={read} style={{ marginTop: 28, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <input
          type="url"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="marinahair.ae"
          autoFocus
          required
          spellCheck={false}
          style={{ flex: "1 1 280px", padding: "12px 14px", fontSize: 15 }}
          disabled={stage === "reading"}
        />
        <button className="btn btn-accent" type="submit" disabled={stage === "reading"} style={{ padding: "12px 22px" }}>
          {stage === "reading" ? "Reading it…" : "Read my website"}
        </button>
      </form>

      {stage === "reading" && (
        <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>
          This takes a few seconds — it is reading the whole site, not just the
          front page.
        </p>
      )}

      {error && (
        <div style={{ marginTop: 22, maxWidth: "56ch" }}>
          <p role="alert" style={{ fontSize: 13.5, color: "var(--bad)", margin: "0 0 8px" }}>
            {error}
          </p>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            No website, or one Belline cannot read?{" "}
            <a href="/agents">Set it up by hand instead</a> — it is the same
            fields, typed rather than read.
          </p>
        </div>
      )}

      <p className="muted" style={{ fontSize: 12.5, marginTop: 34, lineHeight: 1.6, maxWidth: "52ch" }}>
        Nothing is live until you say so. Belline will not answer a call until
        you have seen what it learned and pressed save.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 0.36fr) minmax(0, 1fr)",
        gap: 18,
        padding: "16px 0",
        borderBottom: "1px solid var(--border-soft)",
        alignItems: "baseline",
      }}
    >
      <div className="muted" style={{ fontSize: 12.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 15, lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}
