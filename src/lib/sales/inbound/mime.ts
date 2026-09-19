/**
 * Enough of a MIME parser to know who wrote, what they said, and what it is.
 *
 * Not a general one. A general one is a dependency with a CVE history, and the
 * questions this engine asks of an inbound message are narrow: the headers
 * that thread it, the first readable text part, and whether the whole thing is
 * a delivery report rather than a person. Everything beyond that — HTML
 * rendering, attachments, nested signatures — is deliberately not parsed,
 * because nothing downstream reads it.
 *
 * Two behaviours here carry more weight than the rest, and both are about not
 * being fooled by our own words coming back:
 *
 *  - **Quoted text is cut off before anything classifies the message.** Our
 *    footer says "Unsubscribe — one click and I will not write again". A
 *    recipient who replies "sure, send me times" with our message quoted below
 *    would, without this, be read as an opt-out and suppressed for good.
 *
 *  - **Encoded words and transfer encodings are decoded.** A German
 *    out-of-office arrives as `=?UTF-8?Q?Abwesenheitsnotiz?=` in the subject
 *    and quoted-printable in the body; a classifier reading the raw bytes sees
 *    neither and calls it a human reply.
 */

export interface ParsedHeaders {
  /** Lower-cased header name → the last value seen, unfolded. */
  get(name: string): string | null;
  /** Every value for a header, in order. */
  all(name: string): string[];
}

export interface ParsedMessage {
  headers: ParsedHeaders;
  from: string | null;
  /** Display name on the From header, when there is one. */
  fromName: string | null;
  to: string[];
  subject: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  date: string | null;
  /** The best readable text, decoded, with the quoted history cut off. */
  text: string;
  /** The same text with the quoted history left on, for the record. */
  fullText: string;
  contentType: string;
  /** True when the message is a delivery status report rather than a person. */
  isDeliveryReport: boolean;
  /** Parsed out of a delivery report: the address that failed and why. */
  report: DeliveryReport | null;
}

export interface DeliveryReport {
  recipient: string | null;
  /** `5.1.1`-shaped, when the report carries one. */
  status: string | null;
  action: string | null;
  diagnostic: string | null;
  /** A 5.x.x status, or an explicit `failed` action with no status. */
  permanent: boolean;
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** Split a raw message into its header block and its body, at the first blank line. */
export function splitMessage(raw: string): { head: string; body: string } {
  const normalised = raw.replace(/\r\n/g, "\n");
  const cut = normalised.indexOf("\n\n");
  if (cut === -1) return { head: normalised, body: "" };
  return { head: normalised.slice(0, cut), body: normalised.slice(cut + 2) };
}

/**
 * Unfold and index a header block.
 *
 * Folding — a header continued on the next line with leading whitespace — is
 * normal in real mail and invisible in test fixtures, which is exactly the
 * combination that produces a parser that works until it meets a long
 * `References` header from Outlook.
 */
export function parseHeaders(head: string): ParsedHeaders {
  const map = new Map<string, string[]>();
  let current: { name: string; value: string } | null = null;

  const flush = () => {
    if (!current) return;
    const key = current.name.toLowerCase();
    map.set(key, [...(map.get(key) ?? []), current.value.trim()]);
    current = null;
  };

  for (const line of head.split("\n")) {
    if (/^[ \t]/.test(line) && current) {
      current.value += ` ${line.trim()}`;
      continue;
    }
    flush();
    const colon = line.indexOf(":");
    if (colon > 0) current = { name: line.slice(0, colon), value: line.slice(colon + 1) };
  }
  flush();

  return {
    get(name) {
      const values = map.get(name.toLowerCase());
      return values && values.length > 0 ? values[values.length - 1] : null;
    },
    all(name) {
      return map.get(name.toLowerCase()) ?? [];
    },
  };
}

/** A parameter off a structured header: `charset` out of `text/plain; charset=utf-8`. */
export function headerParam(header: string | null, name: string): string | null {
  if (!header) return null;
  const match = new RegExp(`;\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, "i").exec(header);
  if (!match) return null;
  return (match[2] ?? match[1]).trim();
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** RFC 2047 `=?UTF-8?B?...?=` and `=?ISO-8859-1?Q?...?=`, anywhere in a value. */
export function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, kind: string, text: string) => {
    try {
      const bytes =
        kind.toLowerCase() === "b"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "binary");
      return decodeBytes(bytes, charset);
    } catch {
      return whole;
    }
  });
}

/**
 * Bytes to a string, in whatever charset the part claims.
 *
 * Node knows utf-8 and latin1 natively and nothing else. A German or French
 * auto-reply in windows-1252 is common enough to matter, and it is close
 * enough to latin1 that reading it as latin1 gives the right words with the
 * wrong quotation marks — which is a far better failure than mojibake.
 */
export function decodeBytes(bytes: Buffer, charset: string | null): string {
  const name = (charset ?? "utf-8").trim().toLowerCase().replace(/^"|"$/g, "");
  if (name === "utf-8" || name === "utf8" || name === "us-ascii" || name === "ascii") {
    return bytes.toString("utf8");
  }
  return bytes.toString("latin1");
}

/** Quoted-printable, including soft line breaks. */
export function decodeQuotedPrintable(text: string): Buffer {
  const joined = text.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      out.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(joined.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(out);
}

function decodeBody(body: string, encoding: string | null, charset: string | null): string {
  const how = (encoding ?? "7bit").trim().toLowerCase();
  if (how === "base64") return decodeBytes(Buffer.from(body.replace(/\s+/g, ""), "base64"), charset);
  if (how === "quoted-printable") return decodeBytes(decodeQuotedPrintable(body), charset);
  return decodeBytes(Buffer.from(body, "binary"), charset);
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

interface Part {
  headers: ParsedHeaders;
  body: string;
  contentType: string;
}

/** Every leaf part, depth first. Multiparts are walked, not returned. */
function leaves(head: string, body: string, depth = 0): Part[] {
  const headers = parseHeaders(head);
  const contentType = (headers.get("content-type") ?? "text/plain").trim();
  const boundary = headerParam(contentType, "boundary");

  // A depth limit rather than trust: a crafted message can nest multiparts
  // until something recurses off the stack, and there is no legitimate mail
  // ten levels deep.
  if (!/^multipart\//i.test(contentType) || !boundary || depth > 8) {
    return [{ headers, body, contentType }];
  }

  const out: Part[] = [];
  const marker = `--${boundary}`;
  const pieces = body.split(new RegExp(`^${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(--)?\\s*$`, "m"));
  for (const piece of pieces.slice(1)) {
    const trimmed = piece.replace(/^\n/, "");
    if (!trimmed.trim()) continue;
    const split = splitMessage(trimmed);
    out.push(...leaves(split.head, split.body, depth + 1));
  }
  return out.length > 0 ? out : [{ headers, body, contentType }];
}

/** Very rough HTML to text: enough that an HTML-only reply is still readable. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<blockquote/gi, "\n> <blockquote")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Cutting the quoted history off
// ---------------------------------------------------------------------------

/**
 * Where a reply stops being what they wrote and starts being what we wrote.
 *
 * Every mail client marks this differently and none of them is required to.
 * The patterns below are the ones that cover Gmail, Outlook (English, German,
 * French), Apple Mail and the mobile clients — and when none matches, the
 * whole text is kept, because keeping our own footer is a cosmetic problem and
 * cutting somebody's sentence in half is not.
 */
const QUOTE_MARKERS: RegExp[] = [
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^-{2,}\s*Urspr(?:ü|ue)ngliche Nachricht\s*-{2,}/im,
  /^-{2,}\s*Message d'origine\s*-{2,}/im,
  /^_{10,}\s*$/m,
  /^On .{1,120}\bwrote:\s*$/im,
  /^Am .{1,120}\bschrieb\b.{0,40}:\s*$/im,
  /^Le .{1,120}\ba (?:é|e)crit\s*:\s*$/im,
  /^From:\s*.+$\n^(?:Sent|Date):\s*/im,
  /^Von:\s*.+$\n^Gesendet:\s*/im,
  /^De\s*:\s*.+$\n^(?:Envoy(?:é|e)|Date)\s*:\s*/im,
  /^Sent from my \w+/im,
];

export function stripQuoted(text: string): string {
  let cut = text.length;
  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(text);
    if (match && match.index < cut) cut = match.index;
  }
  let head = text.slice(0, cut);

  // Trailing `>` quoting, which some clients use without any marker line.
  const lines = head.split("\n");
  let end = lines.length;
  while (end > 0 && (lines[end - 1].trim() === "" || lines[end - 1].startsWith(">"))) end--;
  head = lines.slice(0, end).join("\n");

  // If cutting left nothing, the markers lied — a one-line reply above a
  // signature, say. Keep the original rather than classify an empty string.
  return head.trim() ? head.trim() : text.trim();
}

// ---------------------------------------------------------------------------
// Delivery reports
// ---------------------------------------------------------------------------

function parseReport(parts: Part[]): DeliveryReport | null {
  const status = parts.find((p) => /message\/delivery-status/i.test(p.contentType));
  if (!status) return null;
  const fields = parseHeaders(status.body.replace(/\n\n/g, "\n"));
  const code = fields.get("status");
  const action = fields.get("action");
  const recipient = (fields.get("final-recipient") ?? fields.get("original-recipient") ?? "")
    .split(";")
    .pop()
    ?.trim()
    .toLowerCase();
  return {
    recipient: recipient && recipient.includes("@") ? recipient : null,
    status: code,
    action,
    diagnostic: fields.get("diagnostic-code"),
    // A 4.x.x is "try again later" and is not a reason to suppress anybody;
    // only a 5.x.x, or a report that says failed with no code at all, is.
    permanent: code ? code.trim().startsWith("5") : /failed/i.test(action ?? ""),
  };
}

// ---------------------------------------------------------------------------
// The whole message
// ---------------------------------------------------------------------------

export function parseMessage(raw: string): ParsedMessage {
  const { head, body } = splitMessage(raw);
  const headers = parseHeaders(head);
  const parts = leaves(head, body);
  const contentType = (headers.get("content-type") ?? "text/plain").trim();

  const plain = parts.find((p) => /^text\/plain/i.test(p.contentType));
  const html = parts.find((p) => /^text\/html/i.test(p.contentType));
  const chosen = plain ?? html ?? parts[0];

  let fullText = "";
  if (chosen) {
    const decoded = decodeBody(
      chosen.body,
      chosen.headers.get("content-transfer-encoding"),
      headerParam(chosen.contentType, "charset"),
    );
    fullText = /^text\/html/i.test(chosen.contentType) ? htmlToText(decoded) : decoded;
  }

  const fromHeader = headers.get("from");
  const fromMatch = fromHeader ? /<([^<>]+)>/.exec(fromHeader) : null;
  const from = (fromMatch ? fromMatch[1] : (fromHeader ?? "")).trim().toLowerCase() || null;
  const fromName = fromHeader && fromMatch ? decodeWords(fromHeader.slice(0, fromMatch.index)).trim().replace(/^"|"$/g, "") : null;

  const references = (headers.get("references")?.match(/<[^<>\s]+>/g) ?? []).map((v) => v.replace(/^<|>$/g, ""));

  const report = parseReport(parts);

  return {
    headers,
    from: from && from.includes("@") ? from : null,
    fromName: fromName || null,
    to: [headers.get("to"), headers.get("cc"), headers.get("delivered-to"), headers.get("x-original-to")]
      .filter(Boolean)
      .flatMap((h) => h!.split(","))
      .map((piece) => {
        const angled = /<([^<>]+)>/.exec(piece);
        return (angled ? angled[1] : piece).trim().replace(/^"|"$/g, "").toLowerCase();
      })
      .filter((a) => a.includes("@")),
    subject: headers.get("subject") ? decodeWords(headers.get("subject")!) : null,
    messageId: headers.get("message-id")?.replace(/^<|>$/g, "").trim() ?? null,
    inReplyTo: headers.get("in-reply-to")?.replace(/^<|>$/g, "").trim() ?? null,
    references,
    date: headers.get("date"),
    text: stripQuoted(fullText),
    fullText,
    contentType,
    isDeliveryReport: /multipart\/report/i.test(contentType) || report !== null,
    report,
  };
}
