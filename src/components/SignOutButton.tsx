"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
    // A full reload rather than router.push: it clears every cached server
    // component, so nothing from the signed-in session stays on screen.
    window.location.href = "/login";
    router.refresh();
  }

  return (
    <button
      onClick={signOut}
      disabled={busy}
      title="Sign out"
      style={{
        background: "none",
        border: "1px solid var(--border)",
        borderRadius: 8,
        color: "var(--muted)",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 500,
        padding: "5px 9px",
        fontFamily: "inherit",
        flexShrink: 0,
      }}
    >
      {busy ? "…" : "Sign out"}
    </button>
  );
}
