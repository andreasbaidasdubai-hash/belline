/**
 * A venue's own logo — checking it, and serving it safely. Pure, no store.
 *
 * The logo is the one file an owner hands us that we then show to *other
 * people*: on the chat window, and on the button in the corner of the venue's
 * website, which is somebody else's page entirely. So the rules here are
 * written for the file being hostile, not for it being large.
 *
 * - The type comes from the bytes, never from the name or the browser's MIME
 *   type, both of which are only what the file claims (as in onboarding/uploads.ts).
 * - PNG, JPG and WebP are taken as they are. They cannot run anything, and
 *   they are served with their own content-type and `nosniff`, so a polyglot
 *   that is also valid HTML is still only ever an image.
 * - SVG is taken only after it has been parsed and rebuilt from an allowlist.
 *   Anything that does not parse under the strict grammar below is refused
 *   rather than guessed at: a sanitiser that tries to repair broken markup is
 *   how markup gets smuggled past it.
 *
 * And whatever got through is served with a CSP that forbids everything and
 * sandboxes the document, so an SVG opened directly in a tab still cannot run
 * a script even if something here were ever wrong.
 */

export const LOGO_LIMITS = {
  /** A logo, not a photograph. Plenty for a 512px PNG; keeps the store small. */
  maxBytes: 512 * 1024,
  kinds: "PNG, JPG, WebP or SVG",
} as const;

export type LogoMime = "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";

export const LOGO_EXTENSIONS: Record<LogoMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** An uploaded logo's public id: random per upload, so the URL is also its version. */
export const LOGO_ID = /^lg_[0-9a-f]{24}$/;

/** Where a venue's uploaded logo is served, or null when it has none. */
export function logoUrlFor(location: { logo?: { id: string } }): string | null {
  return location.logo && LOGO_ID.test(location.logo.id) ? `/api/logo/${location.logo.id}` : null;
}

export type LogoCheck =
  | { ok: true; mime: LogoMime; bytes: Buffer }
  | { ok: false; message: string };

/** What the first bytes say a raster file is, or null. */
export function sniffRaster(bytes: Uint8Array): Exclude<LogoMime, "image/svg+xml"> | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 12 && starts(ascii("RIFF")) && starts(ascii("WEBP"), 8)) return "image/webp";
  return null;
}

/**
 * The whole check: empty, too large, what it really is, and for SVG the
 * rebuilt, safe copy. `bytes` in the result is what should be stored.
 */
export function checkLogo(input: Uint8Array): LogoCheck {
  if (input.length === 0) return { ok: false, message: "That file is empty. Choose your logo again." };
  if (input.length > LOGO_LIMITS.maxBytes) {
    return { ok: false, message: "That logo is larger than 512 KB. Save a smaller copy — a 512 px PNG is plenty." };
  }
  const raster = sniffRaster(input);
  if (raster) return { ok: true, mime: raster, bytes: Buffer.from(input) };

  const svg = sanitiseSvg(input);
  if (svg.ok) return { ok: true, mime: "image/svg+xml", bytes: Buffer.from(svg.svg, "utf8") };
  return { ok: false, message: svg.message };
}

// ---------------------------------------------------------------------------
// SVG

const NOT_A_LOGO = `That file is not a ${LOGO_LIMITS.kinds} image. Save your logo as one of those and try again.`;
const UNSAFE_SVG = "That SVG has parts we can't show safely. Save it as a PNG and upload that instead.";

/** Drawn, grouped or described — the elements a logo is made of. Case matters in SVG. */
const KEEP = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath", "defs", "symbol", "use", "title", "desc", "style",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "marker",
  "filter", "feGaussianBlur", "feOffset", "feBlend", "feFlood", "feComposite",
  "feColorMatrix", "feMerge", "feMergeNode", "feMorphology", "feDropShadow",
]);

/**
 * Removed with everything inside them. Scripts and the ways to reach one
 * (foreignObject carries HTML, `a` a link, animate/set can rewrite an href),
 * outside resources (image, feImage), and the editor clutter Illustrator and
 * Inkscape leave behind. Anything neither kept nor listed here is refused.
 */
const DROP = new Set([
  "script", "foreignObject", "a", "animate", "animateMotion", "animateTransform", "set",
  "handler", "listener", "iframe", "embed", "object", "image", "feImage", "audio", "video",
  "metadata", "switch", "cursor", "font", "font-face",
]);

/** Something that could not be drawn is not a logo; refused rather than stored blank. */
const DRAWN = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "use"]);

type SvgResult = { ok: true; svg: string } | { ok: false; message: string };

/** Entities decoded, controls and whitespace removed, lower case: the form a check can trust. */
function flatten(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) % 0x110000))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d) % 0x110000))
    .replace(/&(colon|tab|newline);/gi, (_, n) => (n.toLowerCase() === "colon" ? ":" : ""))
    .replace(/[\s\x00-\x1f\x7f]+/g, "")
    .toLowerCase();
}

/** A value that could load or run something. `url(#id)` points inside the file and is fine. */
function dangerous(value: string): boolean {
  const flat = flatten(value);
  if (/javascript:|vbscript:|data:|expression\(|@import|-moz-binding|behavior:|\\/.test(flat)) return true;
  // Every url(...) must be a fragment.
  for (const m of flat.matchAll(/url\(([^)]*)\)?/g)) {
    if (!/^["']?#/.test(m[1] ?? "")) return true;
  }
  return false;
}

/** Entities limited to XML's own five and numeric references; nothing a DOCTYPE could have defined. */
const TEXT_OK = /^(?:[^<&]|&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)*$/;

const NAME = "[A-Za-z_][-A-Za-z0-9_.]*(?::[A-Za-z_][-A-Za-z0-9_.]*)?";
const ATTR = new RegExp(`\\s+(${NAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, "y");
const START = new RegExp(`<(${NAME})`, "y");

function escapeAttr(value: string): string {
  // Values were checked against TEXT_OK, so `&` only begins a safe reference.
  return value.replace(/"/g, "&quot;");
}

/**
 * Parse, check and rebuild an SVG from the allowlist.
 *
 * The grammar is deliberately narrower than XML: no DOCTYPE, no entity
 * declarations, no processing instructions but the XML declaration, quoted
 * attributes only, and every tag closed in order. Real logo exports fit it;
 * anything that does not is refused. The output is written from the parsed
 * tokens, never copied from the input, so what is served is exactly what was
 * checked.
 */
export function sanitiseSvg(input: Uint8Array): SvgResult {
  let src: string;
  try {
    src = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return { ok: false, message: NOT_A_LOGO };
  }
  src = src.replace(/^﻿/, "");
  if (src.includes("\0")) return { ok: false, message: NOT_A_LOGO };
  // Must look like SVG before it is worth parsing — an executable or a PDF
  // renamed .svg ends here, with the plain "not an image" answer.
  const head = src.replace(/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*/, "");
  if (!/^<svg[\s>]/.test(head)) {
    return { ok: false, message: /^<!DOCTYPE\s+svg/i.test(head) ? UNSAFE_SVG : NOT_A_LOGO };
  }

  const out: string[] = [];
  /** Open elements: name, and whether it (or an ancestor) is being dropped. */
  const stack: { name: string; dropped: boolean }[] = [];
  let drawn = false;
  let rootSeen = false;
  let rootClosed = false;
  let i = 0;

  const fail = (): SvgResult => ({ ok: false, message: UNSAFE_SVG });
  const dropping = () => stack.length > 0 && stack[stack.length - 1].dropped;

  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end < 0) return fail();
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end < 0) return fail();
      const body = src.slice(i + 9, end);
      const parent = stack[stack.length - 1];
      // CDATA only as a stylesheet's body, which is where exporters put it.
      if (!parent || parent.name !== "style") return fail();
      if (!parent.dropped) {
        if (dangerous(body) || body.includes("<")) return fail();
        out.push(`<![CDATA[${body}]]>`);
      }
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      // The XML declaration, once, before anything else. Never a stylesheet PI.
      const m = /^<\?xml(?:\s[^?>]*)?\?>/.exec(src.slice(i));
      if (!m || rootSeen) return fail();
      i += m[0].length;
      continue;
    }
    if (src.startsWith("<!", i)) return fail(); // DOCTYPE, ENTITY and friends.

    if (src.startsWith("</", i)) {
      const m = new RegExp(`^</(${NAME})\\s*>`).exec(src.slice(i));
      if (!m) return fail();
      const top = stack.pop();
      if (!top || top.name !== m[1]) return fail();
      if (!top.dropped) out.push(`</${top.name}>`);
      if (stack.length === 0) rootClosed = true;
      i += m[0].length;
      continue;
    }

    if (src[i] === "<") {
      START.lastIndex = i;
      const m = START.exec(src);
      if (!m) return fail();
      const name = m[1];
      let j = START.lastIndex;
      const attrs: [string, string][] = [];
      for (;;) {
        ATTR.lastIndex = j;
        const a = ATTR.exec(src);
        if (!a) break;
        attrs.push([a[1], a[2] ?? a[3] ?? ""]);
        j = ATTR.lastIndex;
      }
      const close = /^\s*(\/?)>/.exec(src.slice(j));
      if (!close) return fail();
      i = j + close[0].length;
      const selfClosing = close[1] === "/";

      if (rootClosed) return fail(); // A second root.
      if (!rootSeen) {
        if (name !== "svg") return fail();
        rootSeen = true;
      }

      const dropped =
        dropping() || DROP.has(name) || name.includes(":"); // inkscape:, sodipodi: and the like.
      if (!dropped && !KEEP.has(name)) return fail();

      if (!dropped) {
        if (DRAWN.has(name)) drawn = true;
        const kept: string[] = [];
        let hasXmlns = false;
        for (const [attr, value] of attrs) {
          if (!TEXT_OK.test(value)) return fail();
          const lower = attr.toLowerCase();
          if (lower.startsWith("on")) continue; // Every event handler, whatever its case.
          if (attr === "xmlns") {
            if (value !== "http://www.w3.org/2000/svg") continue;
            hasXmlns = true;
            kept.push(`xmlns="${value}"`);
            continue;
          }
          if (attr === "xmlns:xlink") {
            if (value === "http://www.w3.org/1999/xlink") kept.push(`xmlns:xlink="${value}"`);
            continue;
          }
          if (attr === "href" || attr === "xlink:href") {
            // Inside the file only: a reference to another shape, never a URL.
            if (/^#[A-Za-z_][-A-Za-z0-9_.:]*$/.test(value)) kept.push(`${attr}="${value}"`);
            continue;
          }
          if (attr === "xml:space") {
            if (value === "preserve" || value === "default") kept.push(`xml:space="${value}"`);
            continue;
          }
          if (attr.includes(":")) continue; // Editor namespaces.
          if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(attr)) continue;
          if (dangerous(value)) continue;
          kept.push(`${attr}="${escapeAttr(value)}"`);
        }
        // An SVG served as an image does not render without its namespace.
        if (name === "svg" && stack.length === 0 && !hasXmlns) kept.unshift('xmlns="http://www.w3.org/2000/svg"');
        out.push(`<${name}${kept.length ? " " + kept.join(" ") : ""}${selfClosing ? "/>" : ">"}`);
      }
      if (!selfClosing) stack.push({ name, dropped });
      else if (stack.length === 0) rootClosed = true;
      continue;
    }

    // Text.
    const next = src.indexOf("<", i);
    const text = src.slice(i, next < 0 ? src.length : next);
    i = next < 0 ? src.length : next;
    if (!rootSeen || rootClosed) {
      if (text.trim()) return fail();
      continue;
    }
    if (!TEXT_OK.test(text)) return fail();
    if (dropping()) continue;
    const parent = stack[stack.length - 1];
    if (parent?.name === "style" && dangerous(text)) return fail();
    out.push(text);
  }

  if (!rootSeen || stack.length > 0) return fail();
  if (!drawn) return { ok: false, message: "That SVG has nothing in it we can draw. Save it as a PNG and upload that instead." };

  const svg = out.join("");
  // Belt and braces over everything above: none of these may survive.
  if (/<script|<foreignobject|javascript:|\son[a-z]+\s*=|<!doctype|<!entity/i.test(svg)) return fail();
  return { ok: true, svg };
}

// ---------------------------------------------------------------------------
// Serving

/**
 * The headers a logo is served with.
 *
 * `nosniff` so the browser believes the content-type we checked rather than
 * its own guess; the CSP forbids every fetch and sandboxes the document, which
 * matters for an SVG opened directly in a tab; CORP cross-origin because the
 * whole point is to be drawn on the venue's own website. The URL changes on
 * every upload, so it can be cached for a year.
 */
export function logoHeaders(mime: LogoMime, length: number): Record<string, string> {
  return {
    "content-type": mime === "image/svg+xml" ? "image/svg+xml; charset=utf-8" : mime,
    "content-length": String(length),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "cross-origin-resource-policy": "cross-origin",
    "cache-control": "public, max-age=31536000, immutable",
    "content-disposition": `inline; filename="logo.${LOGO_EXTENSIONS[mime]}"`,
    "referrer-policy": "no-referrer",
  };
}
