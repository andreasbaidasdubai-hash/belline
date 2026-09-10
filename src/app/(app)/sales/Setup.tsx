import type { SetupState } from "@/lib/sales/kpi/overview";

/**
 * What the sales dashboard shows before there is a database.
 *
 * Deliberately a first-class screen rather than an error. The sales engine is
 * additive — the voice product runs perfectly without it — so "not configured"
 * is an ordinary state that a new machine, a fresh clone and a reviewer will
 * all land in, and the useful thing to put on screen is the two commands that
 * move them out of it.
 */

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li style={{ marginBottom: 20 }}>
      <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 6 }}>
        <span
          className="mono"
          style={{
            display: "inline-block",
            width: 20,
            height: 20,
            lineHeight: "20px",
            textAlign: "center",
            borderRadius: 10,
            background: "var(--accent)",
            color: "#fff",
            fontSize: 11,
            marginRight: 9,
          }}
        >
          {n}
        </span>
        {title}
      </div>
      <div className="muted" style={{ fontSize: 13, lineHeight: 1.6, paddingLeft: 29 }}>
        {children}
      </div>
    </li>
  );
}

function Command({ children }: { children: string }) {
  return (
    <pre
      className="mono"
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 7,
        padding: "9px 12px",
        fontSize: 12,
        margin: "8px 0 0",
        overflowX: "auto",
      }}
    >
      {children}
    </pre>
  );
}

export default function Setup({ state }: { state: SetupState }) {
  return (
    <div className="panel" style={{ padding: "26px 28px", maxWidth: 760 }}>
      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>
        The sales engine is not connected yet
      </div>
      <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.6, margin: "0 0 22px" }}>
        It runs on its own Postgres database, separate from the booking store — so the
        phone line, the diary and every venue page above keep working exactly as they do
        now whether this is set up or not.
      </p>

      <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {state === "no_database" && (
          <Step n={1} title="Create a Postgres database">
            On Railway: <strong>New → Database → Postgres</strong>, then open its{" "}
            <strong>Variables</strong> tab and copy <code className="mono">DATABASE_URL</code>.
            Paste it into <code className="mono">.env</code> in the project root.
            <Command>{`DATABASE_URL=postgres://user:pass@host:5432/railway`}</Command>
          </Step>
        )}

        <Step n={state === "no_database" ? 2 : 1} title="Create the tables">
          Thirty tables in their own <code className="mono">sales</code> schema. Nothing
          it does touches <code className="mono">data/*.json</code>.
          <Command>npm run sales:db -- migrate</Command>
        </Step>

        <Step n={state === "no_database" ? 3 : 2} title="Load the reference data">
          Countries with their compliance profiles, verticals, the Belline service
          catalogue, outreach sequences, and the agent hierarchy — Sales Director, three
          country managers, and the UAE Dental Agent as a draft.
          <Command>npm run sales:db -- seed</Command>
        </Step>

        <Step n={state === "no_database" ? 4 : 3} title="Start the worker">
          A separate process from the voice server. Every pipeline stage runs here.
          <Command>npm run worker</Command>
        </Step>
      </ol>

      <div
        className="muted"
        style={{
          fontSize: 12.5,
          lineHeight: 1.6,
          borderTop: "1px solid var(--border)",
          paddingTop: 16,
          marginTop: 4,
        }}
      >
        {state === "not_migrated" && (
          <>
            The database is reachable but the <code className="mono">sales</code> schema
            is missing. Run the migration above.{" "}
          </>
        )}
        {state === "not_seeded" && (
          <>
            The tables exist but there are no agents yet. Run the seed above.{" "}
          </>
        )}
        Check the current state any time with{" "}
        <code className="mono">npm run sales:db -- status</code>. The design documents
        are in <code className="mono">docs/sales-engine/</code>.
      </div>
    </div>
  );
}
