"use client";

import { useId, useRef, useState } from "react";
import { LOGO_LIMITS } from "@/lib/logo";

/**
 * The venue's logo: choose, see, replace, remove.
 *
 * Self-contained on purpose — it is mounted on the business page, in the
 * website step of setup and beside the widget's look, and in each place it
 * does the whole job itself against /api/logo. `onChange` is only so the
 * screen around it can follow (the widget preview switching to the logo).
 *
 * The page checks size before sending, to save a slow upload that would be
 * refused; the server checks everything again, by the file's bytes, and its
 * answer is what is shown. An SVG may come back refused for having parts that
 * cannot be shown safely; the message says to save a PNG instead, which is an
 * instruction an owner can follow.
 */
export default function LogoUpload({
  locationId,
  logoUrl: logoUrlAtLoad,
  onChange,
}: {
  locationId: string;
  logoUrl: string | null;
  onChange?: (url: string | null) => void;
}) {
  const inputId = useId();
  const hintId = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(logoUrlAtLoad);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // The name of the file that is on the button now.
  //
  // The browser's own file input went on saying "No file chosen" after a
  // successful upload (founder, f6), and it was telling the truth: the upload
  // finishes by clearing the input, so that choosing the same file again after
  // a refusal tries again rather than doing nothing. The input is now hidden
  // behind a real button, and this is what is read beside it.
  const [chosen, setChosen] = useState<string | null>(null);

  function settle(url: string | null, note: string) {
    setLogoUrl(url);
    setSaved(note);
    onChange?.(url);
  }

  async function upload(file: File) {
    setError(null);
    setSaved(null);
    if (file.size === 0) {
      setError("That file is empty. Choose your logo again.");
      return;
    }
    if (file.size > LOGO_LIMITS.maxBytes) {
      setError("That logo is larger than 512 KB. Save a smaller copy — a 512 px PNG is plenty.");
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/logo?locationId=${encodeURIComponent(locationId)}`, { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as { error?: string; logoUrl?: string | null };
      if (!res.ok || !data.logoUrl) {
        setError(data.error ?? "That didn't upload. Try again in a moment.");
        return;
      }
      setChosen(file.name);
      settle(data.logoUrl, "Logo saved.");
    } catch {
      setError("That didn't upload. Try again in a moment.");
    } finally {
      setBusy(false);
      // Choosing the same file again after a refusal should try again.
      if (input.current) input.current.value = "";
    }
  }

  async function remove() {
    setError(null);
    setSaved(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/logo?locationId=${encodeURIComponent(locationId)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That didn't remove it. Try again in a moment.");
        return;
      }
      setChosen(null);
      settle(null, "Logo removed.");
    } catch {
      setError("That didn't remove it. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="logo-upload">
      <label htmlFor={inputId}>Your logo</label>
      <div className="logo-upload-row">
        <span className="logo-upload-preview">
          {logoUrl ? <img src={logoUrl} alt="Your logo" /> : <span className="muted">No logo yet</span>}
        </span>
        <div className="logo-upload-actions">
          {/*
            The input itself is off screen, not `display: none`: hidden that
            way it stops being focusable and the label stops reaching it, and
            the only way to a logo would be a mouse. Here it is still a file
            input with a label, still reachable by keyboard, and the button
            below is what is actually drawn.
          */}
          <input
            ref={input}
            id={inputId}
            className="logo-upload-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg"
            aria-describedby={hintId}
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <label htmlFor={inputId} className={`btn logo-upload-pick${busy ? " is-busy" : ""}`}>
            {busy ? "Uploading…" : logoUrl ? "Replace logo" : "Choose a file"}
          </label>
          <span className="muted logo-upload-name" title={chosen ?? undefined}>
            {chosen ?? (logoUrl ? "Your saved logo" : "No file chosen yet")}
          </span>
          {logoUrl && (
            <button type="button" className="btn" onClick={remove} disabled={busy}>
              Remove logo
            </button>
          )}
        </div>
      </div>
      <p id={hintId} className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
        {busy ? "Saving…" : `${LOGO_LIMITS.kinds}, up to 512 KB. A square logo on a plain background looks best in a circle.`}
      </p>
      {error && (
        <p role="alert" style={{ fontSize: 12.5, margin: "6px 0 0", color: "var(--bad)" }}>
          {error}
        </p>
      )}
      {/* Always in the page, so a screen reader hears it when it fills. */}
      <p role="status" className="muted" style={{ fontSize: 12.5, margin: saved && !error ? "6px 0 0" : 0 }}>
        {saved && !error ? saved : ""}
      </p>
    </div>
  );
}
