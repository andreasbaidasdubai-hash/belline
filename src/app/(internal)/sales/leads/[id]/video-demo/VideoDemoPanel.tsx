"use client";

import { useState } from "react";
import type { OpeningCheck, ProspectFacts } from "@/lib/sales/video-demo/context";
import type { EmailDraft } from "@/lib/sales/video-demo/email";
import type { LinkView, DemoLimits } from "@/lib/sales/video-demo/service";
import type { DemoActivityRow } from "@/lib/sales/video-demo/store";

type Props = {
  leadId: number;
  preview: { facts: ProspectFacts; opening: string; check: OpeningCheck } | null;
  unavailable: string | null;
  links: LinkView[];
  timeline: DemoActivityRow[];
  limits: DemoLimits;
  storeKind: "postgres" | "memory";
};

/** The dirham's fixed peg: money on every console page is AED. */
const USD_TO_AED = 3.6725;

async function api(body: Record<string, unknown>) {
  const res = await fetch("/api/sales/video-demos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

export default function VideoDemoPanel({ leadId, preview, unavailable, links: initialLinks, timeline, limits, storeKind }: Props) {
  const [opening, setOpening] = useState(preview?.opening ?? "");
  const [check, setCheck] = useState<OpeningCheck | null>(preview?.check ?? null);
  const [ttlDays, setTtlDays] = useState(30);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState(initialLinks);
  const [draft, setDraft] = useState<{ link: LinkView; draft: EmailDraft } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const dirty = preview ? opening.trim() !== preview.opening : false;

  async function runCheck() {
    setBusy("check");
    setError(null);
    const { ok, data } = await api({ action: "preview", leadId, opening });
    setBusy(null);
    if (!ok) return setError(data.error ?? "Could not check the opening.");
    setCheck(data.check);
  }

  async function create() {
    setBusy("create");
    setError(null);
    const { ok, data } = await api({ action: "create", leadId, opening, ttlDays });
    setBusy(null);
    if (!ok) {
      setError([data.error, ...(data.problems ?? [])].filter(Boolean).join(" · ") || "Could not create the link.");
      return;
    }
    setLinks((l) => [data.link, ...l]);
    setDraft({ link: data.link, draft: data.draft });
  }

  async function showDraft(link: LinkView) {
    setBusy(`draft:${link.id}`);
    const { ok, data } = await api({ action: "draft", id: link.id });
    setBusy(null);
    if (!ok) return setError(data.error ?? "Could not build the draft.");
    setDraft({ link, draft: data.draft });
  }

  // No browser dialog (the console's rule): the first click asks in the row, the second revokes.
  const [confirming, setConfirming] = useState<string | null>(null);

  async function revoke(link: LinkView) {
    if (confirming !== link.id) return setConfirming(link.id);
    setConfirming(null);
    setBusy(`revoke:${link.id}`);
    const { ok, data } = await api({ action: "revoke", id: link.id });
    setBusy(null);
    if (!ok) return setError(data.error ?? "Could not revoke.");
    setLinks((ls) => ls.map((l) => (l.id === link.id ? data.link : l)));
    if (draft?.link.id === link.id) setDraft(null);
  }

  async function copy(label: string, text: string, prepared?: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1600);
      if (prepared) void api({ action: "prepared", id: prepared });
    } catch {
      setError("The browser did not allow copying. Select the text and copy it by hand.");
    }
  }

  const words = opening.trim().split(/\s+/).filter(Boolean).length;
  const problems = check?.problems ?? [];

  return (
    <div className="split">
      <div>
        <div className="panel" style={{ marginBottom: 18 }}>
          <div className="panel-head">Create video demo</div>
          {!preview ? (
            <p className="muted" style={{ padding: "18px", margin: 0, fontSize: 13 }}>
              {unavailable}
            </p>
          ) : (
            <div style={{ padding: "14px 18px", display: "grid", gap: 12 }}>
              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>Belle&apos;s opening</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  Spoken first on the call, and the first chat message. Written from the research; edit it if you like. It is
                  checked against the research before a link can be made.
                </span>
                <textarea
                  value={opening}
                  onChange={(e) => {
                    setOpening(e.target.value);
                    setCheck(null);
                  }}
                  rows={7}
                  style={{ width: "100%", font: "inherit", fontSize: 13.5, lineHeight: 1.55, padding: 10, borderRadius: 8, border: "1px solid var(--border)", resize: "vertical" }}
                />
              </label>
              <div className="muted" style={{ fontSize: 12 }}>
                {words} words · about {Math.round(words / 2.5)}s spoken{words > 95 ? " · too long, keep it under 95 words" : ""}
              </div>

              {check && (
                <div style={{ fontSize: 12.5, display: "grid", gap: 4 }}>
                  {problems.length === 0 ? (
                    <span style={{ color: "var(--ok)" }}>✓ Passes the guards: nothing in it goes beyond the research.</span>
                  ) : (
                    problems.map((p) => (
                      <span key={p} style={{ color: "var(--accent)" }}>
                        ✗ {p}
                      </span>
                    ))
                  )}
                  {check.warnings.map((w) => (
                    <span key={w} className="muted">
                      ! {w}
                    </span>
                  ))}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button type="button" className="btn" onClick={() => void runCheck()} disabled={busy !== null}>
                  {busy === "check" ? "Checking…" : "Check opening"}
                </button>
                <label className="muted" style={{ fontSize: 12.5, display: "inline-flex", gap: 6, alignItems: "center" }}>
                  Link lasts
                  <select value={ttlDays} onChange={(e) => setTtlDays(Number(e.target.value))}>
                    <option value={7}>7 days</option>
                    <option value={14}>14 days</option>
                    <option value={30}>30 days</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="btn btn-accent"
                  onClick={() => void create()}
                  disabled={busy !== null || !check || problems.length > 0 || words === 0}
                  title={!check ? "Check the opening first" : undefined}
                >
                  {busy === "create" ? "Creating…" : "Create link"}
                </button>
                {dirty && (
                  <button type="button" className="btn" onClick={() => { setOpening(preview.opening); setCheck(preview.check); }}>
                    Reset
                  </button>
                )}
              </div>
              {error && (
                <p style={{ margin: 0, fontSize: 12.5, color: "var(--accent)" }} role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
        </div>

        {draft && <DraftPreview draft={draft.draft} link={draft.link} copied={copied} onCopy={copy} />}

        <div className="panel" style={{ marginBottom: 18 }}>
          <div className="panel-head">
            Demo links
            <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 11.5 }}>
              {limits.videoSessionsPerDay} video calls and {limits.chatsPerDay} chats a day per link
            </span>
          </div>
          {links.length === 0 ? (
            <p className="muted" style={{ padding: "18px", margin: 0, fontSize: 13 }}>
              No links yet.
            </p>
          ) : (
            <table>
              <tbody>
                {links.map((l) => (
                  <tr key={l.id}>
                    <td style={{ fontSize: 12.5 }}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <span className="pill" style={{ fontSize: 10.5 }}>{l.status}</span>
                        {l.hot && (
                          <span className="pill" style={{ fontSize: 10.5, color: "var(--ok)", fontWeight: 700 }}>
                            Hot
                          </span>
                        )}
                        <span className="muted mono" style={{ fontSize: 11 }}>
                          {new Date(l.createdAt).toLocaleDateString()} → {new Date(l.expiresAt).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                        {l.stats.opens} opens · {l.stats.videoSessions} video ({l.stats.videoSeconds}s, longest {l.stats.longestVideoSeconds}s) ·{" "}
                        {l.stats.chats} chats · {l.stats.questions} questions
                        {l.stats.topics.length ? ` · ${l.stats.topics.join(", ")}` : ""}
                        {l.stats.outcomes.length ? ` · outcome: ${l.stats.outcomes.join(", ")}` : ""}
                        {l.stats.getStartedClicks ? ` · Get started ×${l.stats.getStartedClicks}` : ""}
                        {` · video cost about AED ${(l.stats.costUsd * USD_TO_AED).toFixed(2)}`}
                      </div>
                    </td>
                    <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                      <button type="button" className="btn" onClick={() => void copy(`link:${l.id}`, l.url)} disabled={l.status !== "active"}>
                        {copied === `link:${l.id}` ? "Copied" : "Copy link"}
                      </button>{" "}
                      <button type="button" className="btn" onClick={() => void showDraft(l)} disabled={busy !== null}>
                        Email draft
                      </button>{" "}
                      <button type="button" className={confirming === l.id ? "btn btn-danger" : "btn"} onClick={() => void revoke(l)} disabled={l.status !== "active" || busy !== null}>
                        {confirming === l.id ? "Revoke: the page stops working at once" : "Revoke"}
                      </button>
                      {confirming === l.id && (
                        <>
                          {" "}
                          <button type="button" className="btn" onClick={() => setConfirming(null)}>
                            Cancel
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div>
        {preview && (
          <div className="panel" style={{ marginBottom: 18 }}>
            <div className="panel-head">What Belle knows</div>
            <div style={{ padding: "12px 16px", display: "grid", gap: 9, fontSize: 12.5 }}>
              <Fact label="Business">{[preview.facts.businessName, preview.facts.trade, preview.facts.city].filter(Boolean).join(" · ")}</Fact>
              <Fact label="Contact">{preview.facts.firstName ?? "—"}</Fact>
              <Fact label="Services">{preview.facts.services.join(", ") || "—"}</Fact>
              <Fact label="Channels">{preview.facts.channels.join("; ") || "—"}</Fact>
              <Fact label="Likely pain">{preview.facts.painPoints.join("; ")}</Fact>
              <Fact label="Numbers">
                {[
                  preview.facts.roi.locationCount ? `${preview.facts.roi.locationCount} locations` : "",
                  preview.facts.roi.reviewCount ? `${preview.facts.roi.reviewCount} reviews` : "",
                  preview.facts.roi.rating ? `${preview.facts.roi.rating}★` : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </Fact>
              <Fact label="Research">{preview.facts.researchedAt ? preview.facts.researchedAt.slice(0, 10) : "—"}</Fact>
              <p className="muted" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5 }}>
                Only these facts reach Belle, snapshotted when the link is created. Nothing the visitor says can change them.
              </p>
            </div>
          </div>
        )}

        <div className="panel">
          <div className="panel-head">Demo timeline</div>
          {timeline.length === 0 ? (
            <p className="muted" style={{ padding: "18px", margin: 0, fontSize: 13 }}>
              Nothing yet.
            </p>
          ) : (
            <table>
              <tbody>
                {timeline.slice(0, 30).map((t) => (
                  <tr key={t.id}>
                    <td style={{ fontSize: 12.5 }}>
                      {t.summary}
                      {t.data.hot ? <span className="pill" style={{ marginLeft: 6, fontSize: 10, color: "var(--ok)" }}>Hot</span> : null}
                      <div className="muted" style={{ fontSize: 11 }}>
                        {String(t.data.event ?? t.type).replace(/_/g, " ")} · {new Date(t.at).toLocaleString()}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {storeKind === "memory" && (
            <p className="muted" style={{ padding: "8px 16px 14px", margin: 0, fontSize: 11 }}>
              Local run: links and timeline are kept in memory, not in the sales database.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function DraftPreview({
  draft,
  link,
  copied,
  onCopy,
}: {
  draft: EmailDraft;
  link: LinkView;
  copied: string | null;
  onCopy: (label: string, text: string, prepared?: string) => Promise<void>;
}) {
  const blocked = draft.blocked.length > 0;
  return (
    <div className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-head">
        Email draft
        <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 11.5 }}>
          Nothing is sent from the console. Copy it, or open it in your own mail app, check it and send it yourself.
        </span>
      </div>
      <div style={{ padding: "12px 18px", display: "grid", gap: 10 }}>
        <div style={{ fontSize: 12.5, display: "grid", gap: 3 }}>
          <div>
            <span className="muted">To</span> {draft.to ?? "—"}
          </div>
          <div>
            <span className="muted">Subject</span> {draft.subject}
          </div>
          <div className="muted">
            {draft.words} words personalised · link {link.status}
          </div>
        </div>
        {(blocked || draft.problems.length > 0) && (
          <div style={{ fontSize: 12.5, display: "grid", gap: 3 }} role="alert">
            {[...draft.blocked, ...draft.problems].map((b) => (
              <span key={b} style={{ color: "var(--accent)" }}>
                ✗ {b}
              </span>
            ))}
          </div>
        )}
        <iframe
          title="Email preview"
          sandbox=""
          srcDoc={["<!doctype html><html><body style=\"margin:0;padding:16px;background:#fff\">", draft.html, "</body></html>"].join("")}
          style={{ width: "100%", height: 560, border: "1px solid var(--border)", borderRadius: 8, background: "#fff" }}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn" disabled={blocked} onClick={() => void onCopy("text", `Subject: ${draft.subject}\n\n${draft.text}`, link.id)}>
            {copied === "text" ? "Copied" : "Copy text"}
          </button>
          <button type="button" className="btn" disabled={blocked} onClick={() => void onCopy("html", draft.html, link.id)}>
            {copied === "html" ? "Copied" : "Copy HTML"}
          </button>
          {draft.mailto && !blocked ? (
            <a
              className="btn btn-accent"
              href={draft.mailto}
              onClick={() => {
                void fetch("/api/sales/video-demos", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ action: "prepared", id: link.id }),
                  keepalive: true,
                });
              }}
            >
              Open in email app
            </a>
          ) : (
            <button type="button" className="btn btn-accent" disabled>
              Open in email app
            </button>
          )}
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
          The mail-app version is plain text; paste the HTML into a client that accepts it to include the picture.
        </p>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "86px 1fr", gap: 8 }}>
      <span className="muted">{label}</span>
      <span style={{ wordBreak: "break-word" }}>{children}</span>
    </div>
  );
}
