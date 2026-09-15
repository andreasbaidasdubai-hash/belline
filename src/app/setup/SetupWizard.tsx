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
  /** "" when only documents were read. */
  sourceUrl: string;
  documents?: number;
  gaps: { field: string; question: string; why: string }[];
}

type Stage = "ask" | "reading" | "review" | "saving" | "done";

// The same limits the server enforces (lib/onboarding/uploads.ts), repeated
// here so the owner hears about a fourth file before waiting on an upload.
// The server checks again, and checks the bytes, whatever this says.
const MAX_FILES = 3;
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp";
const ACCEPTED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const ACCEPTED_NAME = /\.(pdf|jpe?g|png|webp)$/i;

function sizeOf(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "example.ae", "2 documents", or "example.ae and 2 documents". */
function readFrom(draft: Draft): string {
  let host = "";
  try {
    host = draft.sourceUrl ? new URL(draft.sourceUrl).hostname : "";
  } catch {
    host = draft.sourceUrl;
  }
  const n = draft.documents ?? 0;
  const docs = n ? `${n === 1 ? "one document" : `${n} documents`}` : "";
  return host && docs ? `${host} and ${docs}` : host || docs;
}

/** What the owner handed over, as the owner would say it: "your site", "your documents". */
function sourcesSay(draft: Draft): string {
  const n = draft.documents ?? 0;
  if (draft.sourceUrl) return n ? "your site and documents" : "your site";
  return n === 1 ? "your document" : "your documents";
}

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
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  function addFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    // Cleared so choosing the same file again, after removing it, still fires.
    event.target.value = "";
    const next = [...files];
    let problem: string | null = null;
    for (const file of picked) {
      if (next.some((f) => f.name === file.name && f.size === file.size)) continue;
      if (!ACCEPTED_TYPES.includes(file.type) && !ACCEPTED_NAME.test(file.name)) {
        problem = `"${file.name}" is not a PDF, JPG, PNG or WebP file.`;
        continue;
      }
      if (file.size > MAX_BYTES) {
        problem = `"${file.name}" is larger than 10 MB. Try a smaller copy, or a photo of the page.`;
        continue;
      }
      if (next.length >= MAX_FILES) {
        problem = `You can add up to ${MAX_FILES} files. Remove one to add another.`;
        break;
      }
      next.push(file);
    }
    setFiles(next);
    setFileError(problem);
  }

  function removeFile(index: number) {
    setFiles(files.filter((_, i) => i !== index));
    setFileError(null);
  }

  async function read(event: React.FormEvent) {
    event.preventDefault();
    if (!website.trim() && !files.length) {
      setError("Paste your website address, or add a price list or brochure.");
      return;
    }
    setStage("reading");
    setError(null);
    try {
      let init: RequestInit;
      if (files.length) {
        const form = new FormData();
        form.set("website", website.trim());
        for (const file of files) form.append("files", file);
        init = { method: "POST", body: form };
      } else {
        init = {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ website }),
        };
      }
      const res = await fetch("/api/setup", init);
      const body = (await res.json()) as { ok?: boolean; draft?: Draft; error?: string };
      if (!res.ok || !body.draft) {
        setError(body.error ?? (files.length ? "Could not read those." : "Could not read that page."));
        setStage("ask");
        return;
      }
      setDraft(body.draft);
      setStage("review");
    } catch {
      setError(files.length ? "Could not send those files. Check your connection and try again." : "Could not reach that address.");
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
          // A count for the version note. The files themselves are long gone.
          documents: draft.documents ?? 0,
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

  const serif = { fontFamily: "var(--bl-font-display)", fontWeight: 700 } as const;
  // The same label as the questions on the review screen: sentence case, not the form-caps default.
  const fieldLabel = { display: "block", textTransform: "none", letterSpacing: 0, fontSize: 14, fontWeight: 600, margin: "0 0 6px" } as const;

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
          {missing.length > 0 && (
            <a className="btn btn-accent" href="/setup/assistant" style={{ padding: "12px 20px" }}>
              Finish with Belle
            </a>
          )}
          <a className={missing.length > 0 ? "btn" : "btn btn-accent"} href="/test" style={{ padding: "12px 20px" }}>
            Talk to {venueName}
          </a>
          <a className="btn" href="/golive" style={{ padding: "12px 20px" }}>
            Put it on my phone line
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
          Read from {readFrom(draft)}. Change anything that is
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
                      {s.price ? ` · ${s.price}` : ` · no price on ${sourcesSay(draft)}`}
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
              {(() => {
                const what = sourcesSay(draft);
                const verb = what === "your site" || what === "your document" ? "doesn't" : "don't";
                return draft.gaps.length === 1
                  ? `One thing ${what} ${verb} say.`
                  : `${draft.gaps.length} things ${what} ${verb} say.`;
              })()}
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

      <form onSubmit={read} style={{ marginTop: 28, display: "grid", gap: 22 }}>
        <div>
          <label htmlFor="setup-website" style={fieldLabel}>
            Your website address
          </label>
          {/* Not type="url": the browser refuses "yourbusiness.ae" without https://,
              which is how nearly everybody types it. */}
          <input
            id="setup-website"
            type="text"
            inputMode="url"
            autoComplete="url"
            aria-label="Your website address"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="yourbusiness.ae"
            autoFocus
            spellCheck={false}
            style={{ padding: "12px 14px", fontSize: 15 }}
            disabled={stage === "reading"}
          />
        </div>

        <div
          style={{
            border: "1px dashed var(--border)",
            borderRadius: 12,
            background: "var(--panel)",
            padding: "16px 16px 14px",
          }}
        >
          <label htmlFor="setup-files" style={fieldLabel}>
            Add a price list or brochure
          </label>
          <p id="setup-files-hint" className="muted" style={{ fontSize: 12.5, margin: "0 0 10px", lineHeight: 1.5 }}>
            Up to {MAX_FILES} files — PDF, JPG, PNG or WebP, 10 MB each. Your website, your files, or both.
          </p>
          <style>{`
            .setup-files { padding: 8px; font-size: 14px; background: var(--bg); cursor: pointer; }
            .setup-files::file-selector-button {
              font: inherit; font-weight: 600; margin-right: 12px; padding: 8px 14px; min-height: 38px;
              border: 1px solid var(--border); border-radius: 999px; background: var(--panel); color: var(--text); cursor: pointer;
            }
            .setup-files:hover::file-selector-button { border-color: var(--accent-line); background: var(--panel-2); }
          `}</style>
          <input
            id="setup-files"
            className="setup-files"
            type="file"
            multiple
            accept={ACCEPT}
            aria-describedby={fileError ? "setup-files-hint setup-files-error" : "setup-files-hint"}
            onChange={addFiles}
            disabled={stage === "reading" || files.length >= MAX_FILES}
          />

          {fileError && (
            <p id="setup-files-error" role="alert" style={{ fontSize: 13, color: "var(--bad)", margin: "10px 0 0" }}>
              {fileError}
            </p>
          )}

          {files.length > 0 && (
            <ul aria-label="Files to read" style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 8 }}>
              {files.map((file, i) => (
                <li
                  key={`${file.name}-${file.size}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "6px 6px 6px 12px",
                    border: "1px solid var(--border-soft)",
                    borderRadius: 10,
                    background: "var(--bg)",
                  }}
                >
                  <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {file.name}
                  </span>
                  <span className="muted" style={{ fontSize: 12.5, flex: "none" }}>
                    {sizeOf(file.size)}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => removeFile(i)}
                    disabled={stage === "reading"}
                    aria-label={`Remove ${file.name}`}
                    style={{ padding: "6px 12px", fontSize: 13, flex: "none" }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <button className="btn btn-accent" type="submit" disabled={stage === "reading"} style={{ padding: "12px 22px" }}>
            {stage === "reading"
              ? "Reading it…"
              : files.length && website.trim()
                ? "Read my website and files"
                : files.length
                  ? files.length === 1
                    ? "Read my file"
                    : "Read my files"
                  : "Read my website"}
          </button>
        </div>
      </form>

      {stage === "reading" && (
        <p className="muted" role="status" style={{ fontSize: 13, marginTop: 16 }}>
          This takes a few seconds.
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
