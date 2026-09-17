"use client";

import { useState } from "react";
import type { Vertical } from "@/lib/types";
import {
  CONFIDENCE_LABEL,
  confidenceOf,
  formFromDraft,
  parseHours,
  parseStaff,
  payloadFromForm,
  REVIEW_IDS,
  sourceLabel,
  type Confidence,
  type CurrentVenue,
  type FieldError,
  type Found,
  type ReviewForm,
  type Source,
} from "@/lib/onboarding/review";
import { COUNTRIES, readStoredPhone } from "@/lib/phone";

/**
 * Setup as a conversation.
 *
 * The form this replaces would have asked for an address, opening hours, a
 * price list, a staff list and eight FAQs — perhaps forty fields, typed by
 * somebody who already published all of it on their own website.
 *
 * So: paste the website, Belline reads it, and the owner checks what it found
 * on one form where every line can be changed. Nothing read reaches the venue
 * until the owner presses save. Each value read says where it came from, so
 * the owner can see what a model took off a public web page; pressing "That's
 * right — save it" on that screen is the confirmation. There used to be a tick
 * beside the hours, the address and the prices as well, and it only added a
 * second thing to press and a way to be stuck without seeing why.
 *
 * Anything that stops the save is shown under its own input, in red, and focus
 * moves to the first one. Nothing is only said at the bottom of the form.
 *
 * Setting up by hand opens the same form, filled with what the venue already
 * has. There is one form, so the hand-typed path cannot drift from the read one.
 */

interface Draft {
  found: Found & { vertical: Vertical; timezone: string };
  /** "" when only documents were read. */
  sourceUrl: string;
  documents?: number;
  gaps: { field: string; question: string; why: string }[];
}

type Stage = "ask" | "reading" | "review" | "saving";

// The same limits the server enforces (lib/onboarding/uploads.ts), repeated
// here so the owner hears about a fourth file before waiting on an upload.
// The server checks again, and checks the bytes, whatever this says.
const MAX_FILES = 3;
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp";
const ACCEPTED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const ACCEPTED_NAME = /\.(pdf|jpe?g|png|webp)$/i;
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function sizeOf(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function hhmm(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
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

/**
 * Keep the address bar on the step being shown, without a navigation that
 * would drop the draft held in this component. A refresh then opens the same
 * step, from what is saved.
 */
function showStep(step: "import" | "review") {
  window.history.replaceState(null, "", `/setup/${step}`);
}

export default function SetupWizard({
  vertical,
  currency,
  current,
  start,
  lengthsRequired,
  country = "AE",
}: {
  vertical: Vertical;
  /** The business's own market (ISO): the country a phone typed without its code is read with. */
  country?: string;
  currency: string;
  /**
   * Does each service need a length? Only where Belline books it into a day
   * itself (booking/destination.ts `serviceLengthsRequired`). Otherwise a
   * service needs only a name.
   */
  lengthsRequired: boolean;
  current: CurrentVenue;
  /** "review" opens the form straight away, from what is saved. */
  start: "ask" | "review";
}) {
  const [stage, setStage] = useState<Stage>(start);
  const [website, setWebsite] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [form, setForm] = useState<ReviewForm | null>(start === "review" ? formFromDraft(null, "typed", current) : null);
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  /** Problems with particular inputs on the review, shown under each one. */
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [fallback, setFallback] = useState<string | null>(null);
  const [newStaff, setNewStaff] = useState("");
  const isRestaurant = vertical === "restaurant";

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

  function byHand() {
    setDraft(null);
    setForm(formFromDraft(null, "typed", current));
    setError(null);
    setFallback(null);
    setStage("review");
    showStep("review");
  }

  async function read(event: React.FormEvent) {
    event.preventDefault();
    if (!website.trim() && !files.length) {
      setError("Paste your website address, or add a price list or brochure.");
      return;
    }
    setStage("reading");
    setError(null);
    setFallback(null);
    try {
      let init: RequestInit;
      if (files.length) {
        const body = new FormData();
        body.set("website", website.trim());
        for (const file of files) body.append("files", file);
        init = { method: "POST", body };
      } else {
        init = {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ website }),
        };
      }
      const res = await fetch("/api/setup", init);
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; draft?: Draft; error?: string; fallback?: string };
      if (!res.ok || !body.draft) {
        setError(body.error ?? (files.length ? "Belline could not read those." : "Belline could not read that page."));
        setFallback(body.fallback ?? null);
        setStage("ask");
        return;
      }
      const source: Source = body.draft.sourceUrl ? (body.draft.documents ? "both" : "website") : "documents";
      // The server never keeps a file's name, but this page chose the file, so
      // "from price-list.pdf" can be said when there was exactly one.
      setFileName(!body.draft.sourceUrl && files.length === 1 ? files[0].name : undefined);
      setDraft(body.draft);
      setForm(formFromDraft(body.draft.found, source, current));
      setStage("review");
      showStep("review");
    } catch {
      setError(files.length ? "Could not send those files. Check your connection and try again." : "Could not reach that address.");
      setStage("ask");
    }
  }

  /**
   * Take the owner to an input: scrolled to the middle of the screen, clear of
   * the sticky save bar, and focused so a screen reader reads its message.
   */
  function focusField(id: string) {
    // After React has rendered the message and the red outline.
    window.setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
      el.focus({ preventScroll: true });
    }, 0);
  }

  function showErrors(list: FieldError[]) {
    setErrors(list);
    setError(null);
    if (list.length) focusField(list[0].id);
  }

  async function save() {
    if (!form) return;
    const check = payloadFromForm(form, { lengthsRequired, country });
    if (!check.ok) {
      showErrors(check.errors);
      return;
    }
    setStage("saving");
    setError(null);
    setErrors([]);
    try {
      const res = await fetch("/api/setup", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...check.body,
          website: draft?.sourceUrl ?? "",
          // A count for the version note. The files themselves are long gone.
          documents: draft?.documents ?? 0,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; next?: string; field?: string; service?: string };
      if (!res.ok) {
        setStage("review");
        // The server checks the same things; when it names a field, the
        // message goes under that field like any other.
        const row = body.service ? form.services.findIndex((s) => s.name.trim() === body.service) : -1;
        const id = row >= 0 ? REVIEW_IDS.serviceMinutes(row) : body.field;
        if (body.error && id) showErrors([{ id, message: body.error }]);
        else setError(body.error ?? "That could not be saved. Try again. Nothing you typed has been lost.");
        return;
      }
      // On to the step the journey gives, read from the venue as it was just
      // saved. Anything still missing is listed where it blocks Go live.
      window.location.href = body.next?.startsWith("/") && !body.next.startsWith("//") ? body.next : "/setup";
    } catch {
      setError("That could not be saved. Check your connection and try again. Nothing you typed has been lost.");
      setStage("review");
    }
  }

  /**
   * Change a value; anything the owner types is theirs, so its source becomes
   * "you typed". Typing into an input clears that input's message; adding or
   * removing a row renumbers the inputs, so it clears them all.
   */
  function edit(patch: (f: ReviewForm) => ReviewForm, field?: string) {
    setForm((f) => (f ? patch(f) : f));
    setError(null);
    setErrors((list) => (field ? list.filter((e) => e.id !== field) : []));
  }

  const serif = { fontFamily: "var(--bl-font-display)", fontWeight: 700 } as const;
  // The same label as the questions on the review screen: sentence case, not the form-caps default.
  const fieldLabel = { display: "block", textTransform: "none", letterSpacing: 0, fontSize: 14, fontWeight: 600, margin: "0 0 6px" } as const;
  const eyebrow = { fontSize: 11.5, letterSpacing: "0.16em", textTransform: "uppercase", margin: "0 0 14px", color: "var(--gold-ink)" } as const;

  // ---- review -------------------------------------------------------------

  if ((stage === "review" || stage === "saving") && form) {
    const why = (field: string) => draft?.gaps.find((g) => g.field === field)?.why;
    const hoursRead = parseHours(form.hours.value);
    const problem = (id: string) => errors.find((e) => e.id === id)?.message;
    /** aria-invalid and the message's id, for an input with a problem. */
    const invalid = (id: string, also?: string) => {
      const described = [problem(id) ? `${id}-error` : "", also ?? ""].filter(Boolean).join(" ");
      return { "aria-invalid": problem(id) ? true : undefined, "aria-describedby": described || undefined };
    };
    const message = (id: string) =>
      problem(id) ? (
        <p id={`${id}-error`} className="field-error">
          {problem(id)}
        </p>
      ) : null;

    return (
      <div>
        <p className="muted" style={eyebrow}>
          Check what Belline will say
        </p>
        <h1 style={{ ...serif, fontSize: 32, letterSpacing: "-0.02em", lineHeight: 1.12, margin: "0 0 14px" }}>
          {draft ? "Here's what I understood." : "Tell Belline about the business."}
        </h1>
        <p style={{ color: "var(--text-2)", fontSize: 15.5, lineHeight: 1.6, maxWidth: "56ch" }}>
          {draft ? `Read from ${readFrom(draft)}. ` : ""}Change anything that is wrong — Belline
          will say exactly what is on this screen, so a price that is out of date here is a
          price a customer gets told. Leave out anything you are unsure of: Belline will say it
          does not know rather than guess.
        </p>

        <div style={{ marginTop: 28, display: "grid", gap: 26 }}>
          <Section label="Business name" source={form.name.source} confidence={confidenceOf("text", form.name.value, form.name.source)} fileName={fileName} htmlFor="review-name">
            <input
              id="review-name"
              value={form.name.value}
              onChange={(e) => edit((f) => ({ ...f, name: { value: e.target.value, source: "typed" } }))}
            />
          </Section>

          <Section label="Answers the phone with" source={form.greeting.source} confidence={confidenceOf("text", form.greeting.value, form.greeting.source)} fileName={fileName} htmlFor="review-greeting">
            <textarea
              id="review-greeting"
              rows={2}
              value={form.greeting.value}
              onChange={(e) => edit((f) => ({ ...f, greeting: { value: e.target.value, source: "typed" } }))}
            />
          </Section>

          <Section
            label="Address"
            hint={why("address")}
            source={form.address.source}
            confidence={confidenceOf("address", form.address.value, form.address.source)}
            fileName={fileName}
            htmlFor="review-address"
          >
            <input
              id="review-address"
              value={form.address.value}
              autoComplete="street-address"
              onChange={(e) => edit((f) => ({ ...f, address: { value: e.target.value, source: "typed" } }))}
            />
          </Section>

          <Section label="Phone number for the business" source={form.phone.source} confidence={confidenceOf("text", form.phone.value, form.phone.source)} fileName={fileName} htmlFor="review-phone">
            {/* With its country code, always: a local number is read with the country picked here. */}
            <div style={{ display: "flex", gap: 8 }}>
              <select
                aria-label="Country code"
                value={form.phoneCountry ?? readStoredPhone(form.phone.value, country).country}
                onChange={(e) => {
                  const iso = e.target.value;
                  edit((f) => ({ ...f, phoneCountry: iso }), REVIEW_IDS.phone);
                }}
                style={{ width: "auto", maxWidth: 150, flex: "0 0 auto" }}
              >
                {COUNTRIES.map((c) => (
                  <option key={c.iso} value={c.iso}>
                    {c.iso} +{c.dial}
                  </option>
                ))}
              </select>
              <input
                id={REVIEW_IDS.phone}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={form.phone.value}
                {...invalid(REVIEW_IDS.phone)}
                style={{ flex: 1, minWidth: 0, ...(problem(REVIEW_IDS.phone) ? { borderColor: "var(--bad)" } : {}) }}
                onChange={(e) => edit((f) => ({ ...f, phone: { value: e.target.value, source: "typed" } }), REVIEW_IDS.phone)}
              />
            </div>
            {problem(REVIEW_IDS.phone) && (
              <p id={`${REVIEW_IDS.phone}-error`} role="alert" style={{ fontSize: 13.5, color: "var(--bad)", margin: "6px 0 0" }}>
                {problem(REVIEW_IDS.phone)}
              </p>
            )}
          </Section>

          <Section
            label="Opening hours"
            hint={why("hours") ?? "Write them as you would on a sign, like Mon-Fri 09:00-18:00; Sat 10:00-16:00; Sun closed."}
            source={form.hours.source}
            confidence={confidenceOf("hours", form.hours.value, form.hours.source)}
            fileName={fileName}
            htmlFor="review-hours"
          >
            <textarea
              id={REVIEW_IDS.hours}
              rows={2}
              value={form.hours.value}
              {...invalid(REVIEW_IDS.hours, hoursRead.ok || problem(REVIEW_IDS.hours) ? "" : "review-hours-reading")}
              onChange={(e) => edit((f) => ({ ...f, hours: { value: e.target.value, source: "typed" } }), REVIEW_IDS.hours)}
            />
            {hoursRead.ok ? (
              <div aria-live="polite" data-testid="hours-preview" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "2px 16px", marginTop: 10, fontSize: 13 }}>
                {WEEK.map((d) => (
                  <div key={d} style={{ display: "flex", gap: 8 }}>
                    <span style={{ width: 34, fontWeight: 600 }}>{DAY_NAMES[d]}</span>
                    <span className="muted">
                      {(hoursRead.hours[d] ?? []).length
                        ? hoursRead.hours[d].map((r) => `${hhmm(r.start)}–${hhmm(r.end)}`).join(", ")
                        : "Closed"}
                    </span>
                  </div>
                ))}
              </div>
            ) : problem(REVIEW_IDS.hours) ? (
              // After pressing save: this input's error.
              message(REVIEW_IDS.hours)
            ) : (
              // While typing: how it reads so far, said under the input.
              <p id="review-hours-reading" role="status" className="field-error">
                {hoursRead.error}
              </p>
            )}
          </Section>

          <Section
            label={isRestaurant ? "On the menu" : "What you offer"}
            hint={
              why("services") ??
              (isRestaurant
                ? "Belline answers questions about the menu. Guests book a table, not a dish."
                : lengthsRequired
                  ? "Belline books these into your diary, so each one needs its length in minutes. The price is optional."
                  : "A name is enough. Minutes and price are optional: with no price, Belline says your team will confirm it.")
            }
          >
            <div style={{ display: "grid", gap: 10 }}>
              {form.services.map((s, i) => (
                <div key={i}>
                  <div className={isRestaurant ? "review-service-row review-menu-row" : "review-service-row"}>
                    <label style={{ display: "grid", gap: 4, fontSize: 12, textTransform: "none", letterSpacing: 0 }}>
                      <span className="muted">
                        {isRestaurant ? "Dish or section" : "Service"} · {sourceLabel(s.source, fileName)}
                      </span>
                      <input
                        value={s.name}
                        aria-label={`${isRestaurant ? "Dish" : "Service"} ${i + 1} name`}
                        onChange={(e) => edit((f) => ({ ...f, services: f.services.map((x, j) => (j === i ? { ...x, name: e.target.value, source: "typed" } : x)) }))}
                      />
                    </label>
                    {!isRestaurant && (
                      <label style={{ display: "grid", gap: 4, fontSize: 12, textTransform: "none", letterSpacing: 0 }}>
                        <span className="muted">Minutes{lengthsRequired ? "" : " · optional"}</span>
                        <input
                          id={REVIEW_IDS.serviceMinutes(i)}
                          type="number"
                          min={5}
                          step={5}
                          inputMode="numeric"
                          aria-label={`Service ${i + 1} minutes`}
                          value={s.durationMin || ""}
                          {...invalid(REVIEW_IDS.serviceMinutes(i))}
                          onChange={(e) =>
                            edit(
                              (f) => ({ ...f, services: f.services.map((x, j) => (j === i ? { ...x, durationMin: Number(e.target.value), source: "typed" } : x)) }),
                              REVIEW_IDS.serviceMinutes(i),
                            )
                          }
                        />
                      </label>
                    )}
                    <label style={{ display: "grid", gap: 4, fontSize: 12, textTransform: "none", letterSpacing: 0 }}>
                      <span className="muted">
                        Price, {currency} · optional
                      </span>
                      <input
                        type="number"
                        min={0}
                        inputMode="decimal"
                        aria-label={`${isRestaurant ? "Dish" : "Service"} ${i + 1} price`}
                        value={s.price || ""}
                        onChange={(e) => edit((f) => ({ ...f, services: f.services.map((x, j) => (j === i ? { ...x, price: Number(e.target.value), source: "typed" } : x)) }))}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: "8px 12px", fontSize: 13 }}
                      aria-label={`Remove ${s.name || `row ${i + 1}`}`}
                      onClick={() => edit((f) => ({ ...f, services: f.services.filter((_, j) => j !== i) }))}
                    >
                      Remove
                    </button>
                  </div>
                  {!isRestaurant && message(REVIEW_IDS.serviceMinutes(i))}
                </div>
              ))}
              <div>
                <button
                  type="button"
                  className="btn"
                  style={{ padding: "8px 14px", fontSize: 13 }}
                  onClick={() => edit((f) => ({ ...f, services: [...f.services, { name: "", durationMin: 0, price: 0, source: "typed" }] }))}
                >
                  {isRestaurant ? "Add a dish" : "Add a service"}
                </button>
              </div>
            </div>
          </Section>

          {!isRestaurant && (
            <Section label="Who works there" hint={why("staff")} htmlFor="review-staff">
              {form.staff.length > 0 && (
                <ul aria-label="Staff" style={{ listStyle: "none", padding: 0, margin: "0 0 10px", display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {form.staff.map((s, i) => (
                    <li key={`${s.value}-${i}`} style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--border)", borderRadius: 999, padding: "4px 6px 4px 12px", fontSize: 14 }}>
                      {s.value}
                      <span className="muted" style={{ fontSize: 11.5 }}>
                        {sourceLabel(s.source, fileName)}
                      </span>
                      <button
                        type="button"
                        className="btn"
                        aria-label={`Remove ${s.value}`}
                        style={{ padding: "2px 9px", fontSize: 12 }}
                        onClick={() => edit((f) => ({ ...f, staff: f.staff.filter((_, j) => j !== i) }))}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  id="review-staff"
                  placeholder="Layla, Omar and Sara"
                  value={newStaff}
                  onChange={(e) => setNewStaff(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    const names = parseStaff(newStaff);
                    if (names.length) edit((f) => ({ ...f, staff: [...f.staff, ...names.map((value) => ({ value, source: "typed" as const }))] }));
                    setNewStaff("");
                  }}
                />
                <button
                  type="button"
                  className="btn"
                  style={{ padding: "8px 14px", fontSize: 13, flex: "none" }}
                  onClick={() => {
                    const names = parseStaff(newStaff);
                    if (names.length) edit((f) => ({ ...f, staff: [...f.staff, ...names.map((value) => ({ value, source: "typed" as const }))] }));
                    setNewStaff("");
                  }}
                >
                  Add
                </button>
              </div>
            </Section>
          )}

          <Section label="Questions it can answer">
            <div style={{ display: "grid", gap: 14 }}>
              {form.faqs.map((q, i) => (
                <div key={i} style={{ display: "grid", gap: 6, paddingBottom: 12, borderBottom: "1px solid var(--border-soft)" }}>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {sourceLabel(q.source, fileName)}
                  </span>
                  <input
                    id={REVIEW_IDS.faqQuestion(i)}
                    aria-label={`Question ${i + 1}`}
                    value={q.q}
                    placeholder="Is there parking?"
                    {...invalid(REVIEW_IDS.faqQuestion(i))}
                    onChange={(e) => edit((f) => ({ ...f, faqs: f.faqs.map((x, j) => (j === i ? { ...x, q: e.target.value, source: "typed" } : x)) }), REVIEW_IDS.faqQuestion(i))}
                  />
                  {message(REVIEW_IDS.faqQuestion(i))}
                  <textarea
                    id={REVIEW_IDS.faqAnswer(i)}
                    aria-label={`Answer ${i + 1}`}
                    rows={2}
                    value={q.a}
                    placeholder="Yes, free parking behind the building."
                    {...invalid(REVIEW_IDS.faqAnswer(i))}
                    onChange={(e) => edit((f) => ({ ...f, faqs: f.faqs.map((x, j) => (j === i ? { ...x, a: e.target.value, source: "typed" } : x)) }), REVIEW_IDS.faqAnswer(i))}
                  />
                  {message(REVIEW_IDS.faqAnswer(i))}
                  <div>
                    <button type="button" className="btn" style={{ padding: "6px 12px", fontSize: 12.5 }} onClick={() => edit((f) => ({ ...f, faqs: f.faqs.filter((_, j) => j !== i) }))}>
                      Remove this question
                    </button>
                  </div>
                </div>
              ))}
              <div>
                <button type="button" className="btn" style={{ padding: "8px 14px", fontSize: 13 }} onClick={() => edit((f) => ({ ...f, faqs: [...f.faqs, { q: "", a: "", source: "typed" }] }))}>
                  Add a question
                </button>
              </div>
            </div>
          </Section>

          <Section
            label="Anything Belline must never do, or must always say?"
            hint={why("policies") ?? "One rule per line. Deposits, cancellation, lateness — the rules your team already follow."}
            source={form.policies.source}
            htmlFor="review-policies"
          >
            <textarea
              id="review-policies"
              rows={3}
              value={form.policies.value}
              onChange={(e) => edit((f) => ({ ...f, policies: { value: e.target.value, source: "typed" } }))}
            />
          </Section>
        </div>

        {error && (
          <p role="alert" style={{ marginTop: 20, fontSize: 13.5, color: "var(--bad)" }}>
            {error}
          </p>
        )}

        {/* Kept on screen while the form scrolls: on a phone the form is many
            screens long, and the one button that moves setup on should not be
            at the bottom of it. */}
        <div
          // fab-clear: the floating bell sits at the bottom right; the buttons stay clear of it.
          className="fab-clear"
          style={{
            display: "flex",
            gap: 12,
            marginTop: 32,
            alignItems: "center",
            flexWrap: "wrap",
            position: "sticky",
            bottom: 0,
            paddingTop: 12,
            paddingBottom: 12,
            background: "var(--bg)",
            borderTop: "1px solid var(--border-soft)",
          }}
        >
          <button className="btn btn-accent" onClick={save} disabled={stage === "saving"} style={{ padding: "12px 22px" }}>
            {stage === "saving" ? "Saving…" : "That's right — save it"}
          </button>
          <button
            className="btn"
            onClick={() => {
              setDraft(null);
              setForm(null);
              setError(null);
              setStage("ask");
              showStep("import");
            }}
            style={{ padding: "12px 18px" }}
          >
            {draft ? "Try a different page" : "Read my website instead"}
          </button>
          {/* Beside the button that did nothing, one short line and a way to
              the next problem. The messages themselves are under their inputs;
              repeating them all here made this sticky bar half a phone screen
              tall, on top of the very fields it pointed at. */}
          {errors.length > 0 && stage !== "saving" && (
            <p role="alert" data-testid="review-problems" style={{ flexBasis: "100%", margin: 0, fontSize: 13, color: "var(--bad)" }}>
              {errors.length === 1 ? "One thing to fix before saving." : `${errors.length} things to fix before saving.`}{" "}
              <a
                href={`#${errors[0].id}`}
                style={{ color: "var(--bad)", textDecoration: "underline" }}
                onClick={(event) => {
                  event.preventDefault();
                  focusField(errors[0].id);
                }}
              >
                Show me
              </a>
            </p>
          )}
        </div>
      </div>
    );
  }

  // ---- ask ----------------------------------------------------------------

  return (
    <div>
      <p className="muted" style={eyebrow}>
        Set up Belline
      </p>
      <h1 style={{ ...serif, fontSize: 34, letterSpacing: "-0.02em", lineHeight: 1.1, margin: "0 0 14px" }}>
        Where can Belline learn about your business?
      </h1>
      <p style={{ color: "var(--text-2)", fontSize: 16, lineHeight: 1.6, maxWidth: "54ch" }}>
        Give it your website, a price list or brochure, or both. Belline drafts
        your services, hours, prices and the questions people ask, and you check
        every line on the next screen.
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

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
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
          <button type="button" className="btn" onClick={byHand} disabled={stage === "reading"} style={{ padding: "12px 18px" }}>
            Set it up by hand
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
          <p className="muted" style={{ fontSize: 13, margin: "0 0 10px" }}>
            {fallback ?? "No website, or one Belline cannot read?"} It is the same form, typed rather than read.
          </p>
          <button type="button" className="btn" onClick={byHand} style={{ padding: "10px 16px" }}>
            Set it up by hand
          </button>
        </div>
      )}

      <p className="muted" style={{ fontSize: 12.5, marginTop: 34, lineHeight: 1.6, maxWidth: "52ch" }}>
        Reading these changes nothing for your customers. They only reach Belline
        once you forward your phone line to it or add the chat to your website.
      </p>
    </div>
  );
}

function Section({
  label,
  hint,
  source,
  confidence,
  fileName,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  source?: Source;
  confidence?: Confidence;
  fileName?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  const tone = confidence === "clear" ? "var(--ok)" : confidence === "check" ? "var(--warn)" : "var(--text-2)";
  return (
    <div style={{ paddingBottom: 22, borderBottom: "1px solid var(--border-soft)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 10px", marginBottom: 6 }}>
        <label htmlFor={htmlFor} style={{ textTransform: "none", letterSpacing: 0, fontSize: 14, fontWeight: 600, margin: 0 }}>
          {label}
        </label>
        {source && (
          <span className="muted" style={{ fontSize: 12 }}>
            {sourceLabel(source, fileName)}
          </span>
        )}
        {confidence && (
          <span style={{ fontSize: 11.5, border: `1px solid ${tone}`, color: tone, borderRadius: 999, padding: "1px 8px" }}>
            {CONFIDENCE_LABEL[confidence]}
          </span>
        )}
      </div>
      {hint && (
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}>
          {hint}
        </p>
      )}
      {children}
    </div>
  );
}
