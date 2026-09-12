"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The list, worked.
 *
 * Three actions and no more, because this is done standing at a desk between
 * two patients: rang them, try again later, undo. Everything else about a
 * recall — who, when, what it is worth, whether they have since rebooked — is
 * derived from the diary and cannot be edited here, which is why there is no
 * save button and no form.
 *
 * The rows are the server's, not a copy of them.
 *
 * The first version held them in state and edited them in place, which read
 * well and was wrong twice over: a row put off for a month stayed on a list it
 * had just been removed from, and the placeholder standing in for the date
 * until the server answered was rendered to the user as "until …". Both are
 * the same mistake — two sources of truth for one list, one of which is a
 * guess. So the write goes out, the row greys while it is in flight, and the
 * refresh brings back the list as it now is.
 */

export type Status = "upcoming" | "due" | "overdue" | "contacted" | "booked";

export interface Row {
  bookingId: string;
  name: string;
  phone: string;
  service: string;
  dueOn: string;
  lastVisit: string;
  overdueDays: number;
  value: number;
  status: Status;
  bookedFor?: string;
  snoozedUntil?: string;
}

const LABEL: Record<Status, string> = {
  overdue: "overdue",
  due: "due",
  upcoming: "coming up",
  contacted: "rung",
  booked: "rebooked",
};

export default function RecallList({
  locationId,
  currency,
  guestWord,
  items,
}: {
  locationId: string;
  currency: string;
  guestWord: string;
  items: Row[];
}) {
  const router = useRouter();
  const rows = items;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(row: Row, action: "contacted" | "snooze" | "clear", days?: number) {
    setBusy(row.bookingId);
    setError(null);

    try {
      const res = await fetch("/api/recall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId, bookingId: row.bookingId, action, days }),
      });
      if (!res.ok) {
        const { error: message } = (await res.json().catch(() => ({}))) as { error?: string };
        setError(message ?? "That did not save.");
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="panel" style={{ padding: "30px 18px" }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Nobody is due back in the next month. That is the list doing its job, not an empty page.
        </p>
      </div>
    );
  }

  return (
    <>
      {error && (
        <div className="panel" style={{ padding: "10px 14px", marginBottom: 12, color: "var(--bad)", fontSize: 12.5 }}>
          {error}
        </div>
      )}

      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>{guestWord.charAt(0).toUpperCase() + guestWord.slice(1)}</th>
              <th>Due back for</th>
              <th>Due</th>
              <th>Worth</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.bookingId} style={{ opacity: busy === row.bookingId ? 0.5 : 1 }}>
                <td>
                  <div style={{ fontWeight: 600 }}>{row.name}</div>
                  {row.phone && (
                    <a className="mono muted" href={`tel:${row.phone.replace(/\s/g, "")}`} style={{ fontSize: 11.5 }}>
                      {row.phone}
                    </a>
                  )}
                </td>
                <td>
                  <div>{row.service}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    last in {row.lastVisit}
                  </div>
                </td>
                <td>
                  <span className="mono">{row.dueOn}</span>
                  <div style={{ fontSize: 11.5, marginTop: 2 }}>
                    <span
                      className="pill"
                      style={{
                        padding: "1px 8px",
                        fontSize: 10.5,
                        ...(row.status === "overdue"
                          ? { color: "var(--bad)", background: "var(--bad-soft)", borderColor: "var(--bad-soft)" }
                          : row.status === "booked"
                            ? { color: "var(--ok)", background: "var(--ok-soft)", borderColor: "var(--ok-soft)" }
                            : {}),
                      }}
                    >
                      {LABEL[row.status]}
                      {row.status === "overdue" ? ` by ${row.overdueDays}d` : ""}
                    </span>
                  </div>
                </td>
                <td className="mono">
                  {currency} {row.value.toLocaleString()}
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {row.status === "booked" ? (
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      booked {row.bookedFor}
                    </span>
                  ) : row.status === "contacted" ? (
                    <>
                      {row.snoozedUntil && (
                        <span className="muted" style={{ fontSize: 11.5, marginRight: 8 }}>
                          until {row.snoozedUntil}
                        </span>
                      )}
                      <button
                        className="btn"
                        style={{ padding: "5px 11px", fontSize: 12 }}
                        disabled={busy !== null}
                        onClick={() => act(row, "clear")}
                      >
                        Undo
                      </button>
                    </>
                  ) : (
                    <div style={{ display: "inline-flex", gap: 6 }}>
                      <button
                        className="btn"
                        style={{ padding: "5px 11px", fontSize: 12 }}
                        disabled={busy !== null}
                        onClick={() => act(row, "contacted")}
                      >
                        Rang them
                      </button>
                      <button
                        className="btn"
                        style={{ padding: "5px 11px", fontSize: 12 }}
                        disabled={busy !== null}
                        title="Off the list for a month"
                        onClick={() => act(row, "snooze", 30)}
                      >
                        Later
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

