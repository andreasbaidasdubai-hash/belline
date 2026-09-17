"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function RevokeButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm(`Revoke the demo link for ${name}? The page stops working at once.`)) return;
        setBusy(true);
        await fetch("/api/sales/video-demos", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "revoke", id }),
        }).catch(() => undefined);
        setBusy(false);
        router.refresh();
      }}
    >
      Revoke
    </button>
  );
}
