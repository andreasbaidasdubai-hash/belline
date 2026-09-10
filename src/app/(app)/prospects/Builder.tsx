"use client";

import { useEffect, useState } from "react";

/**
 * Build a personalised demo from a prospect's website.
 *
 * The whole interaction is one field and one button, because it happens
 * during a phone call — a salesperson pastes a URL while the prospect is
 * still talking, and reads them the link before they hang up.
 */

interface Prospect {
  slug: string;
  name: string;
  vertical: string;
  sourceUrl: string;
  expiresAt: string;
}

export default function Builder() {
  const [url, setUrl] = useState("");
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Prospect | null>(null);
  const [list, setList] = useState<Prospect[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/prospect");
    if (!res.ok) return;
    const data = (await res.json()) as { prospects?: Prospect[] };
    setList(data.prospects ?? []);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function build(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMade(null);
    setBuilding(true);
    try {
      const res = await fetch("/api/prospect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Failed (${res.status}).`);
        return;
      }
      setMade(data as Prospect);
      setUrl("");
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuilding(false);
    }
  }

  function linkFor(slug: string) {
    return `${window.location.origin}/demo/${slug}`;
  }

  async function copy(slug: string) {
    try {
      await navigator.clipboard.writeText(linkFor(slug));
      setCopied(slug);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setError("Your browser would not let me copy. Select the link and copy it by hand.");
    }
  }

  return (
    <>
      <div className="panel" style={{ padding: 20, marginBottom: 20 }}>
        <form onSubmit={build} style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="prospect-url">Their website</label>
            <input
              id="prospect-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="dentalclinic.com"
              disabled={building}
              autoComplete="url"
            />
          </div>
          <button className="btn btn-accent" disabled={building || !url.trim()}>
            {building ? "Reading their site…" : "Build the demo"}
          </button>
        </form>

        <p className="muted" style={{ fontSize: 12, margin: "12px 0 0", lineHeight: 1.55 }}>
          Belline reads the public page and builds a venue from it — name, services,
          people, hours. It is a plausible impression, not their real configuration,
          and the demo page says so. Demos expire after fourteen days.
        </p>

        {error && (
          <div style={{ color: "var(--bad)", fontSize: 12.5, marginTop: 12 }}>{error}</div>
        )}

        {made && (
          <div
            style={{
              marginTop: 16,
              padding: 14,
              borderRadius: 10,
              background: "var(--ok-soft)",
              border: "1px solid var(--border)",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{made.name} is ready.</div>
            <div className="mono" style={{ fontSize: 12.5, margin: "6px 0 10px" }}>
              /demo/{made.slug}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn" onClick={() => copy(made.slug)}>
                {copied === made.slug ? "Copied" : "Copy link"}
              </button>
              <a className="btn" href={`/demo/${made.slug}`} target="_blank" rel="noreferrer">
                Open it
              </a>
            </div>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          Live demos
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
            {list.length} active
          </span>
        </div>
        {list.length === 0 ? (
          <p className="muted" style={{ padding: "26px 18px", fontSize: 13, margin: 0 }}>
            None yet. Paste a prospect&apos;s website above and you will have something
            to send them in about a minute.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <tbody>
                {list.map((p) => (
                  <tr key={p.slug}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{p.name}</div>
                      <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                        {p.sourceUrl}
                      </div>
                    </td>
                    <td style={{ width: 96 }}>
                      <span className="pill">{p.vertical}</span>
                    </td>
                    <td className="muted" style={{ width: 120, fontSize: 12 }}>
                      until {new Date(p.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                    </td>
                    <td style={{ width: 190, textAlign: "right" }}>
                      <button type="button" className="btn" onClick={() => copy(p.slug)}>
                        {copied === p.slug ? "Copied" : "Copy link"}
                      </button>{" "}
                      <a className="btn" href={`/demo/${p.slug}`} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
