/**
 * Die Marke, an einer Stelle.
 *
 * "The Bell Button" in Navy + Electric Blue (15.09.2026): the bell sits in a
 * solid blue (#2667FF) badge, white on blue, and the name is set in Plus
 * Jakarta Sans 700. The badge is the logo, the app icon, the avatar and the
 * shape of the primary button, so it looks the same here as on belline.ai and
 * in public/brand/.
 *
 * The wordmark inherits the text colour of the page, so the same markup reads
 * on light and dark grounds.
 */
export default function Brand({
  size = 26,
  words = true,
  tone,
  bell,
}: {
  /** Nominal size in pixels. The badge is 1.15x, the name 0.9x (canvas: 28 badge, 21 name at 24). */
  size?: number;
  /** false: the badge alone, where the name already stands beside it. */
  words?: boolean;
  /** Badge colour. Unset: blue. */
  tone?: string;
  /** Bell colour. Unset: white, which reads on blue at 4.70:1. */
  bell?: string;
}) {
  const badge = Math.round(size * 1.15);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: Math.round(badge * 0.29),
        color: "inherit",
        textDecoration: "none",
      }}
    >
      <svg
        viewBox="0 0 48 48"
        width={badge}
        height={badge}
        aria-hidden={words ? "true" : undefined}
        role={words ? undefined : "img"}
        aria-label={words ? undefined : "Belline"}
        style={{ display: "block", flexShrink: 0 }}
      >
        <circle cx="24" cy="24" r="24" fill={tone ?? "var(--bl-blue, #2667FF)"} />
        <g fill={bell ?? "#FFFFFF"} transform="matrix(0.6 0 0 0.6 9.6 9.81)">
          <circle cx="24" cy="10" r="4.2" />
          <path d="M8.5 32a15.5 15.5 0 0 1 31 0Z" />
          <rect x="5" y="34.5" width="38" height="7" rx="3.5" />
        </g>
      </svg>
      {words && (
        <span
          style={{
            fontFamily: "var(--bl-font-display)",
            fontSize: Math.round(size * 0.9),
            fontWeight: 700,
            letterSpacing: "-0.025em",
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
