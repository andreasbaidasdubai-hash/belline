import Link from "next/link";

/**
 * The app's own 404.
 *
 * There was none, so a mistyped link on app.belline.ai fell through to Next's
 * bare black-on-white "This page could not be found" — the one screen in the
 * product that looked like somebody else's.
 */
export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "var(--bl-ivory)",
        color: "var(--bl-ink)",
      }}
    >
      <div style={{ maxWidth: 460 }}>
        <p style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--bl-brass-desk)", margin: 0 }}>
          Not found
        </p>
        <h1
          style={{
            fontFamily: "var(--bl-font-display)",
            fontWeight: 700,
            fontSize: 34,
            lineHeight: 1.05,
            letterSpacing: "-0.035em",
            margin: "12px 0 16px",
          }}
        >
          Nobody at this desk.
        </h1>
        <p style={{ fontSize: 16, lineHeight: 1.55, margin: 0, color: "var(--bl-graphite)" }}>
          That page does not exist, or it has moved. The dashboard and the website are both one
          click away.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 24 }}>
          <Link
            href="/"
            style={{ padding: "13px 22px", borderRadius: 999, background: "var(--bl-brass)", color: "var(--bl-ink)", textDecoration: "none", fontWeight: 600 }}
          >
            Open the dashboard
          </Link>
          <a
            href="https://belline.ai/"
            style={{ padding: "13px 22px", borderRadius: 999, border: "1px solid var(--bl-ink)", color: "var(--bl-ink)", textDecoration: "none", fontWeight: 600 }}
          >
            belline.ai
          </a>
        </div>
      </div>
    </main>
  );
}
