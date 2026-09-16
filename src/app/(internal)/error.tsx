"use client";

import { useEffect } from "react";

/**
 * When a sales page throws.
 *
 * There was no error boundary anywhere under `(internal)`, so anything a page
 * failed to catch became Next's own 500 — the whole console replaced by a
 * stack trace or, in production, by a blank page with a digest on it. The
 * revenue page did exactly that whenever Postgres was unreachable, because it
 * awaited two reception calls uncaught.
 *
 * Those two are now handled where they happen, which is the right place: a
 * page that can still show the client book should show it. This is the net
 * under the rest — every page beneath it keeps its chrome, says what failed in
 * a sentence, and offers the one action that is ever useful, which is trying
 * again. The sales database being down must never look like the product being
 * down.
 */
export default function InternalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server digest is all a production build sends; log it so a report of
    // "the console broke" can be matched to the line that broke it.
    console.error("[sales console]", error);
  }, [error]);

  return (
    <div className="panel" style={{ padding: "26px 28px", maxWidth: 620, margin: "48px auto" }}>
      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>
        This page could not be loaded
      </div>
      <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.6, margin: "0 0 18px" }}>
        Something the console needed did not answer — most often the sales
        database. Nothing has been changed by this, and the phone line, the
        diary and every customer-facing page run on a different store and are
        unaffected.
      </p>
      {error.digest && (
        <p className="muted mono" style={{ fontSize: 11.5, margin: "0 0 18px" }}>
          {error.digest}
        </p>
      )}
      <button type="button" className="btn btn-accent" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
