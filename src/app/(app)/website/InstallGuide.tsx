"use client";

import { useState } from "react";

/**
 * Where the snippet goes, one tab per website builder.
 *
 * The last tab is for owners who do not touch their own site: it opens their
 * own email app with the snippet and the steps already written, addressed to
 * nobody, so they send it to whoever does. Belline sends nothing.
 */
export default function InstallGuide({
  snippet,
  tabs,
}: {
  snippet: string;
  tabs: { id: string; name: string; steps: string[]; note?: string }[];
}) {
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  const tab = tabs.find((t) => t.id === active);

  const brief = [
    "Hello,",
    "",
    "Please add this line to every page of our website, just before the closing </body> tag (in the site-wide footer or custom code area):",
    "",
    snippet,
    "",
    "It adds the Belline booking and chat buttons. Nothing else needs changing.",
    "",
    "Thank you",
  ].join("\n");
  const mailto = `mailto:?subject=${encodeURIComponent("Please add this line to our website")}&body=${encodeURIComponent(brief)}`;

  return (
    <div style={{ marginTop: 18 }}>
      <div role="tablist" aria-label="Your website builder" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === active}
            className={t.id === active ? "btn btn-accent" : "btn"}
            onClick={() => setActive(t.id)}
          >
            {t.name}
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected={active === "person"}
          className={active === "person" ? "btn btn-accent" : "btn"}
          onClick={() => setActive("person")}
        >
          Send to my web person
        </button>
      </div>
      <div role="tabpanel" style={{ marginTop: 12, fontSize: 13, lineHeight: 1.7 }}>
        {active === "person" ? (
          <p style={{ margin: 0 }}>
            <a href={mailto}>Open an email with the line and the steps</a>. It opens in your own email app, for you to
            send to whoever looks after your website.
          </p>
        ) : tab ? (
          <>
            <ol style={{ margin: 0, paddingLeft: 20, color: "var(--text-2)" }}>
              {tab.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            {tab.note && (
              <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
                {tab.note}
              </p>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
