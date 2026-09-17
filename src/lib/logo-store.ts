import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir, getLocation, listLocations, upsertLocation } from "./store";
import { LOGO_EXTENSIONS, LOGO_ID, checkLogo, logoHeaders, logoUrlFor, type LogoMime } from "./logo";
import type { Location } from "./types";

/**
 * Where an uploaded logo is kept.
 *
 * In its own file under DATA_DIR/logos, with only a small record of it on the
 * venue. Not base64 inside the venue row, although that would have been one
 * line: locations.json is held in memory by every process and rewritten whole
 * on every change to any venue — a colour saved, an hour moved — so a 500 KB
 * logo there would be ~700 KB of base64 copied into memory and onto disk on
 * every one of those writes, for every venue that has one. A file beside the
 * store is on the same volume, so it is exactly as durable as the venue it
 * belongs to (see DATA_DIR in store.ts), and is read only when somebody asks
 * for the picture.
 *
 * The file is named by the logo's random id, never by anything from the
 * upload, and the id is checked against its pattern before it touches a path.
 */

function dir(): string {
  return path.join(dataDir(), "logos");
}

function fileFor(id: string, mime: LogoMime): string {
  if (!LOGO_ID.test(id)) throw new Error("bad logo id");
  return path.join(dir(), `${id}.${LOGO_EXTENSIONS[mime]}`);
}

/** Temp file plus rename, as the store writes, so a crash never leaves half a logo. */
function writeAtomically(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, bytes);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // OneDrive or an antivirus holding the directory: keep the data, lose atomicity.
    fs.writeFileSync(file, bytes);
    fs.rmSync(tmp, { force: true });
  }
}

function removeFile(logo: Location["logo"]): void {
  if (!logo) return;
  try {
    fs.rmSync(fileFor(logo.id, logo.mime), { force: true });
  } catch {
    /* an orphaned file is untidy, never a failure the owner should see */
  }
}

/** Store a logo that has already passed `checkLogo`, replacing any previous one. */
export function saveLogo(locationId: string, logo: { mime: LogoMime; bytes: Buffer }, now: Date = new Date()): Location {
  const location = getLocation(locationId);
  if (!location) throw new Error("unknown venue");
  const record = {
    id: `lg_${crypto.randomBytes(12).toString("hex")}`,
    mime: logo.mime,
    size: logo.bytes.length,
    updatedAt: now.toISOString(),
  };
  // The file first: a venue must never point at a logo that is not there.
  writeAtomically(fileFor(record.id, record.mime), logo.bytes);
  const previous = location.logo;
  const saved = upsertLocation({ ...location, logo: record });
  if (previous && previous.id !== record.id) removeFile(previous);
  return saved;
}

export function removeLogo(locationId: string): Location | undefined {
  const location = getLocation(locationId);
  if (!location?.logo) return location;
  const previous = location.logo;
  const { logo: _gone, ...rest } = location;
  const saved = upsertLocation(rest as Location);
  removeFile(previous);
  return saved;
}

/** The logo behind a public id, or null. Archived venues serve nothing. */
export function readLogo(id: string): { mime: LogoMime; bytes: Buffer } | null {
  if (!LOGO_ID.test(id)) return null;
  const location = listLocations({ includeInternal: true }).find((l) => l.logo?.id === id);
  if (!location?.logo) return null;
  try {
    return { mime: location.logo.mime, bytes: fs.readFileSync(fileFor(id, location.logo.mime)) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The requests, as plain functions the routes call and the checks can too.

export interface LogoPostResult {
  status: number;
  body: { ok?: true; logoUrl?: string | null; error?: string };
}

/**
 * POST /api/logo, after the route has checked who is asking: multipart with a
 * `file`. Everything checked again here whatever the page already checked.
 */
export async function uploadLogoFromRequest(req: Request, locationId: string): Promise<LogoPostResult> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) {
    return { status: 400, body: { error: "Send the logo as a file upload." } };
  }
  // Refuse an absurd body before buffering it; the real size check is below.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > 2 * 1024 * 1024) {
    return { status: 413, body: { error: "That logo is larger than 512 KB. Save a smaller copy — a 512 px PNG is plenty." } };
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return { status: 400, body: { error: "The upload did not arrive in one piece. Try again." } };
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return { status: 422, body: { error: "Choose your logo first." } };
  }
  const checked = checkLogo(new Uint8Array(await file.arrayBuffer()));
  if (!checked.ok) return { status: 422, body: { error: checked.message } };
  const saved = saveLogo(locationId, checked);
  return { status: 200, body: { ok: true, logoUrl: logoUrlFor(saved) } };
}

/** GET /api/logo/<id>: the picture with its safe headers, or a 404. */
export function serveLogo(id: string): Response {
  const logo = readLogo(id);
  if (!logo) {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" },
    });
  }
  return new Response(new Uint8Array(logo.bytes), { status: 200, headers: logoHeaders(logo.mime, logo.bytes.length) });
}
