"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Role } from "@/lib/types";

interface Person {
  id: string;
  email: string;
  name: string;
  role: Role;
  locationIds: string[];
  disabled: boolean;
  lastSeenAt: string | null;
}

interface Venue {
  id: string;
  name: string;
}

const ROLE_HELP: Record<Role, string> = {
  owner: "Every venue, plus the team page",
  manager: "Chosen venues, can change the agent",
  staff: "Chosen venues, read only",
};

export default function TeamManager({
  people,
  venues,
  currentUserId,
}: {
  people: Person[];
  venues: Venue[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const [draft, setDraft] = useState({
    name: "",
    email: "",
    password: "",
    role: "staff" as Role,
    locationIds: [] as string[],
  });

  async function send(
    method: "POST" | "PATCH" | "DELETE",
    payload: Record<string, unknown>,
    query = "",
  ) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/team${query}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "DELETE" ? undefined : JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That did not work.");
        return false;
      }
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function addPerson(event: React.FormEvent) {
    event.preventDefault();
    const ok = await send("POST", draft);
    if (ok) {
      setDraft({ name: "", email: "", password: "", role: "staff", locationIds: [] });
      setAdding(false);
    }
  }

  return (
    <>
      {error && (
        <div
          style={{
            background: "var(--bad-soft)",
            border: "1px solid var(--bad)",
            color: "var(--bad)",
            borderRadius: 10,
            padding: "10px 14px",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th style={{ width: 190 }}>Role</th>
                <th>Venues</th>
                <th style={{ width: 130 }}>Last signed in</th>
                <th style={{ width: 170 }}></th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr key={person.id} style={person.disabled ? { opacity: 0.45 } : undefined}>
                  <td>
                    <div style={{ fontWeight: 600 }}>
                      {person.name}
                      {person.id === currentUserId && (
                        <span className="pill" style={{ marginLeft: 8 }}>you</span>
                      )}
                      {person.disabled && (
                        <span
                          className="pill"
                          style={{ marginLeft: 8, color: "var(--bad)", borderColor: "var(--bad)" }}
                        >
                          disabled
                        </span>
                      )}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>{person.email}</div>
                  </td>
                  <td>
                    <select
                      value={person.role}
                      aria-label={`Role for ${person.name}`}
                      disabled={busy}
                      onChange={(e) =>
                        send("PATCH", { userId: person.id, role: e.target.value })
                      }
                    >
                      {(Object.keys(ROLE_HELP) as Role[]).map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                      {ROLE_HELP[person.role]}
                    </div>
                  </td>
                  <td>
                    {person.role === "owner" ? (
                      <span className="muted" style={{ fontSize: 12.5 }}>All venues</span>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {venues.map((v) => {
                          const on = person.locationIds.includes(v.id);
                          return (
                            <button
                              key={v.id}
                              className="pill"
                              disabled={busy}
                              onClick={() =>
                                send("PATCH", {
                                  userId: person.id,
                                  locationIds: on
                                    ? person.locationIds.filter((x) => x !== v.id)
                                    : [...person.locationIds, v.id],
                                })
                              }
                              style={{
                                cursor: "pointer",
                                background: on ? "var(--accent)" : "var(--panel-2)",
                                color: on ? "#fff" : "var(--muted)",
                                borderColor: on ? "var(--accent)" : "var(--border)",
                              }}
                            >
                              {v.name}
                            </button>
                          );
                        })}
                        {person.locationIds.length === 0 && (
                          <span className="muted" style={{ fontSize: 11.5 }}>
                            none — they will see nothing
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {person.lastSeenAt
                      ? new Date(person.lastSeenAt).toLocaleDateString()
                      : "never"}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button
                        className="btn"
                        disabled={busy}
                        style={{ padding: "5px 10px", fontSize: 11.5 }}
                        onClick={() => {
                          const password = window.prompt(
                            `New password for ${person.name}. Send it to them yourself and ask them to change it.`,
                          );
                          if (password) send("PATCH", { userId: person.id, password });
                        }}
                      >
                        Reset password
                      </button>
                      {person.id !== currentUserId && (
                        <button
                          className="btn btn-danger"
                          disabled={busy}
                          style={{ padding: "5px 10px", fontSize: 11.5 }}
                          onClick={() =>
                            send("PATCH", {
                              userId: person.id,
                              disabled: !person.disabled,
                            })
                          }
                        >
                          {person.disabled ? "Enable" : "Disable"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {adding ? (
        <form className="panel" onSubmit={addPerson} style={{ padding: 20, maxWidth: 520 }}>
          <h2 style={{ fontSize: 15, margin: "0 0 16px", fontWeight: 600 }}>Add someone</h2>

          <div style={{ marginBottom: 14 }}>
            <label htmlFor="np-name">Name</label>
            <input
              id="np-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              required
            />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="np-email">Email</label>
            <input
              id="np-email"
              type="email"
              value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              required
            />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="np-password">First password</label>
            <input
              id="np-password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              required
            />
            <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
              At least 10 characters. Give it to them in person or over a
              message, and reset it if you think it leaked.
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="np-role">Role</label>
            <select
              id="np-role"
              value={draft.role}
              onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}
            >
              {(Object.keys(ROLE_HELP) as Role[]).map((r) => (
                <option key={r} value={r}>
                  {r} — {ROLE_HELP[r]}
                </option>
              ))}
            </select>
          </div>

          {draft.role !== "owner" && (
            <div style={{ marginBottom: 18 }}>
              <label>Venues</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {venues.map((v) => {
                  const on = draft.locationIds.includes(v.id);
                  return (
                    <button
                      type="button"
                      key={v.id}
                      className="pill"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          locationIds: on
                            ? draft.locationIds.filter((x) => x !== v.id)
                            : [...draft.locationIds, v.id],
                        })
                      }
                      style={{
                        cursor: "pointer",
                        background: on ? "var(--accent)" : "var(--panel-2)",
                        color: on ? "#fff" : "var(--muted)",
                        borderColor: on ? "var(--accent)" : "var(--border)",
                      }}
                    >
                      {v.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="btn btn-accent" disabled={busy}>
              {busy ? "…" : "Add"}
            </button>
            <button type="button" className="btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button className="btn btn-accent" onClick={() => setAdding(true)}>
          + Add someone
        </button>
      )}
    </>
  );
}
