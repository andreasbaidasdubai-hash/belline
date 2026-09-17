import { draftFromSources, type Draft, type DraftDeps } from "./index";
import type { SourceFile } from "../prospect";
import { customerError, raiseException } from "../errors/customer";
import { flag } from "../flags";

/**
 * A price list or a brochure, handed over at setup.
 *
 * Plenty of businesses here have no website worth reading, or one that is a
 * single Instagram link, while the price list is a PDF on the owner's phone.
 * So setup takes up to three documents beside (or instead of) the website.
 *
 * They are read once. The bytes go to the model with the website text, the
 * draft comes back, and the request ends: nothing about the files — not the
 * bytes, not the names — is written to disk, the store, a log or the database.
 * The draft is the same draft a website produces and is saved only when the
 * owner presses save.
 *
 * Everything is checked here, on the server, whatever the page already
 * checked: the count before anything is read, the size before the bytes are
 * buffered, and the type from the bytes themselves. A file called menu.pdf
 * that is really an HTML page is refused, because the extension and the
 * browser's MIME type are both just what the file claims to be.
 */

export const UPLOAD_LIMITS = {
  maxFiles: 3,
  maxBytes: 10 * 1024 * 1024,
  kinds: "PDF, JPG, PNG or WebP",
} as const;

/** What the first bytes say the file is, or null for anything not accepted. */
export function sniff(bytes: Uint8Array): SourceFile["mime"] | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  if (starts(ascii("%PDF-"))) return "application/pdf";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(ascii("RIFF")) && starts(ascii("WEBP"), 8)) return "image/webp";
  return null;
}

export interface SetupPostResult {
  status: number;
  body: { ok?: true; draft?: Draft; error?: string; fallback?: string; fix?: string; code?: string };
}

const FALLBACK = "You can skip this and tell Belline about the business yourself.";

function refuse(error: string, status = 422): SetupPostResult {
  return { status, body: { error } };
}

/** A file's name, fit to quote back to the person who chose it. */
function quoted(name: string): string {
  const clean = name.replace(/[\x00-\x1f"]/g, "").trim() || "That file";
  return `"${clean.length > 60 ? `${clean.slice(0, 57)}...` : clean}"`;
}

/**
 * POST /api/setup, after sign-in: JSON `{ website }` or multipart
 * `website` + `files`. Returns the status and body to send; writes nothing.
 */
export async function draftFromRequest(
  req: Request,
  deps: DraftDeps = {},
  /** Asked with the website before anything is read: a refusal here costs nothing (abuse/review.ts). */
  screen?: (website: string) => SetupPostResult | null,
): Promise<SetupPostResult> {
  const type = req.headers.get("content-type") ?? "";
  let website = "";
  const files: SourceFile[] = [];

  if (type.toLowerCase().startsWith("multipart/form-data")) {
    // Refuse an absurd body before buffering it. The per-file checks below are
    // the real ones; this only stops a gigabyte being read to reach them.
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > UPLOAD_LIMITS.maxFiles * UPLOAD_LIMITS.maxBytes + 1024 * 1024) {
      return refuse(`Those files are too large. Each one can be up to 10 MB, and you can add up to ${UPLOAD_LIMITS.maxFiles}.`);
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return refuse("The upload did not arrive in one piece. Try again.", 400);
    }

    website = String(form.get("website") ?? "").trim();
    const chosen = form.getAll("files").filter((v): v is File => typeof v !== "string");

    if (chosen.length > UPLOAD_LIMITS.maxFiles) {
      return refuse(`You can add up to ${UPLOAD_LIMITS.maxFiles} files. Remove ${chosen.length - UPLOAD_LIMITS.maxFiles === 1 ? "one" : "some"} and try again.`);
    }

    for (const file of chosen) {
      if (file.size > UPLOAD_LIMITS.maxBytes) {
        return refuse(`${quoted(file.name)} is larger than 10 MB. Save a smaller copy, or take a photo of the page instead.`);
      }
      if (file.size === 0) {
        return refuse(`${quoted(file.name)} is empty. Choose the file again.`);
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      const mime = sniff(bytes);
      if (!mime) {
        return refuse(`${quoted(file.name)} is not a ${UPLOAD_LIMITS.kinds} file. Save it as one of those and try again.`);
      }
      files.push({ bytes, mime, name: file.name });
    }

    if (!website && !files.length) {
      return refuse("Paste your website address, or add a price list or brochure.");
    }
  } else {
    let body: { website?: string };
    try {
      body = (await req.json()) as { website?: string };
    } catch {
      return refuse("Send JSON.", 400);
    }
    website = String(body?.website ?? "").trim();
    if (!website) return refuse("Paste the address of your website.");
  }

  const refused = screen?.(website);
  if (refused) return refused;

  // No model to read with. Said honestly, and logged once for the team, rather
  // than letting the SDK complain about a missing key to the owner.
  if (!deps.model && !flag("import.model")) {
    raiseException("import:model_off", "setup import asked for with import.model off");
    const out = customerError("import", "import.model flag is off", "not_configured", "setup");
    return { status: 503, body: { error: `${out.message} ${out.next}`, fallback: FALLBACK } };
  }

  try {
    const draft = await draftFromSources({ website: website || undefined, files }, deps);
    return { status: 200, body: { ok: true, draft } };
  } catch (err) {
    // A typo, a site behind a login, a scan too faint to read: those were
    // written for the owner (CustomerError) and are said as they are. An SDK's
    // own text is not, and is replaced with a plain sentence.
    const out = customerError("import", err, "failed", "setup");
    return { status: 422, body: { error: out.message, fallback: FALLBACK } };
  }
}
