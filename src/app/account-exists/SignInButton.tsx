"use client";

import { useState } from "react";

/** Sign out of this account first, so /login does not bounce straight back to it. */
export default function SignInButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-accent"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
        window.location.href = "/login";
      }}
    >
      {busy ? "…" : "Sign in"}
    </button>
  );
}
