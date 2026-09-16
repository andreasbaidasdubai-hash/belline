"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

/**
 * The way back from an editor that setup sent the owner to.
 *
 * Setup links out to the existing editors (the rules, the forwarding guide, the
 * test console) with ?from=setup, rather than copying them. Without this bar,
 * finishing there left the owner in a dashboard they have not been shown yet.
 */
export default function BackToSetup() {
  const from = useSearchParams().get("from");
  if (from !== "setup") return null;
  return (
    <div className="panel" style={{ padding: "10px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 12 }}>
      <Link href="/setup" className="btn btn-accent" style={{ padding: "8px 16px" }}>
        Back to setup
      </Link>
      <span className="muted" style={{ fontSize: 12.5 }}>
        Setup carries on from where you are.
      </span>
    </div>
  );
}
