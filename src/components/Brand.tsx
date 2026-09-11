/**
 * Die Marke, an einer Stelle.
 *
 * Vorher stand sie an sieben Stellen als `<img src="/logo.svg">` mit je einer
 * eigenen Höhe. Das hatte zwei Folgen: die Wortmarke musste in die Datei
 * eingebrannt werden, obwohl die Seite die Schrift ohnehin lädt, und ein
 * Wechsel der Marke war eine Suche durch sieben Dateien, bei der man eine
 * übersieht.
 *
 * Inline gesetzt erbt das Zeichen `currentColor` und die Wortmarke die
 * Schrift — hell auf dunkel und dunkel auf hell aus demselben Markup, ohne
 * zweite Datei.
 */
export default function Brand({
  size = 26,
  words = true,
  tone,
}: {
  /** Höhe des Zeichens in Pixeln. Die Wortmarke skaliert mit. */
  size?: number;
  /** Nur das Zeichen, etwa wo der Name schon danebensteht. */
  words?: boolean;
  /** Farbe des Zeichens. Unbesetzt nimmt es die Textfarbe an. */
  tone?: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: Math.round(size * 0.42),
        color: "inherit",
        textDecoration: "none",
      }}
    >
      <svg
        viewBox="0 0 48 48"
        width={size}
        height={size}
        fill="none"
        aria-hidden={words ? "true" : undefined}
        role={words ? undefined : "img"}
        aria-label={words ? undefined : "Belline"}
        style={{ display: "block", color: tone ?? "var(--brass)", flexShrink: 0 }}
      >
        <circle cx="24" cy="9.5" r="3.5" fill="currentColor" />
        <path d="M9 31.5a15 15 0 0 1 30 0Z" fill="currentColor" />
        <rect x="5" y="35" width="38" height="5.5" rx="2.75" fill="currentColor" />
      </svg>
      {words && (
        <span
          style={{
            fontFamily: '"Fraunces", Georgia, serif',
            fontSize: Math.round(size * 1.55),
            fontWeight: 500,
            letterSpacing: "-0.015em",
            lineHeight: 1,
          }}
        >
          Belline
        </span>
      )}
    </span>
  );
}
