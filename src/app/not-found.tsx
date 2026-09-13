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
        background: "#FBF9F5",
        color: "#14110D",
      }}
    >
      <div style={{ maxWidth: 460 }}>
        <p style={{ fontSize: 11.5, letterSpacing: "0.16em", textTransform: "uppercase", color: "#8A672E", margin: 0 }}>
          Not found
        </p>
        <h1
          style={{
            fontFamily: "Fraunces, Georgia, serif",
            fontWeight: 400,
            fontSize: 34,
            lineHeight: 1.1,
            letterSpacing: "-0.02em",
            margin: "12px 0 16px",
          }}
        >
          Nobody at this desk.
        </h1>
        <p style={{ fontSize: 16, lineHeight: 1.55, margin: 0, color: "#4A443C" }}>
          That page does not exist, or it has moved. The dashboard and the website are both one
          click away.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 24 }}>
          <Link
            href="/"
            style={{ padding: "13px 22px", borderRadius: 999, background: "#14110D", color: "#FBF9F5", textDecoration: "none", fontWeight: 500 }}
          >
            Open the dashboard
          </Link>
          <a
            href="https://belline.ai/"
            style={{ padding: "13px 22px", borderRadius: 999, border: "1px solid rgba(20,17,13,.22)", color: "#14110D", textDecoration: "none", fontWeight: 500 }}
          >
            belline.ai
          </a>
        </div>
      </div>
    </main>
  );
}
