/**
 * Die Marke, an einer Stelle.
 *
 * Seit dem 15.09.2026: die Glocke in Messing, daneben "Belline" in
 * Instrument Sans, fett und eng gesetzt. Die Serifen-Wortmarke wirkte neben
 * dem Produkt altmodisch; die Glocke bleibt, weil sie das Zeichen ist, das
 * überall sonst steht — Favicon, WhatsApp-Profilbild, die Knöpfe zu Belle.
 *
 * Inline gesetzt erbt die Wortmarke Farbe und Schrift der Seite — hell auf
 * dunkel und dunkel auf hell aus demselben Markup, ohne zweite Datei.
 */
export default function Brand({
  size = 26,
  words = true,
  tone,
}: {
  /** Höhe der Glocke in Pixeln. Die Wortmarke skaliert mit. */
  size?: number;
  /** false: nur die Glocke, etwa wo der Name schon danebensteht. */
  words?: boolean;
  /** Farbe der Glocke. Unbesetzt Messing. */
  tone?: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: Math.round(size * 0.36),
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
            fontFamily: '"Instrument Sans", ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif',
            fontSize: Math.round(size * 1.05),
            fontWeight: 700,
            letterSpacing: "-0.03em",
            lineHeight: 1,
            whiteSpace: "nowrap",
          }}
        >
          Belline
        </span>
      )}
    </span>
  );
}
