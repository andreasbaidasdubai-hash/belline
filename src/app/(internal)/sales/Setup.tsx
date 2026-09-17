import type { SetupState } from "@/lib/sales/kpi/overview";

/**
 * What the AI sales agents' settings show before their database exists.
 *
 * An ordinary state, not an error: the product runs without it, and so do
 * Leads (enquiries, Belle's leads, the waitlist), Customers, Issues and
 * Revenue. Said in plain words, with the commands for whoever runs the server.
 */

function Command({ children }: { children: string }) {
  return (
    <pre className="mono" style={{ background: "var(--bl-ground)", border: "1px solid var(--bl-rule)", borderRadius: 8, padding: "8px 12px", fontSize: 12, margin: "6px 0 0", overflowX: "auto" }}>
      {children}
    </pre>
  );
}

export default function Setup({ state }: { state: SetupState }) {
  const steps: { title: string; body: React.ReactNode }[] = [];
  if (state === "no_database") {
    steps.push({
      title: "Connect the sales database",
      body: "The agents keep the businesses they find in their own Postgres database. Whoever runs the server adds its connection string to the server's settings; nothing else changes.",
    });
  }
  if (state === "no_database" || state === "not_migrated") {
    steps.push({ title: "Create its tables", body: <Command>npm run sales:db -- migrate</Command> });
  }
  steps.push({
    title: "Load the countries, trades and agents",
    body: (
      <>
        Countries with their rules, the trades we sell to, what Belline offers, and the agents: a sales director, a manager
        per country and the first trade agents.
        <Command>npm run sales:db -- seed</Command>
      </>
    ),
  });

  return (
    <div className="panel" style={{ padding: "22px 24px", maxWidth: 760 }}>
      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>The AI sales agents are not set up yet</div>
      <p className="staff-note" style={{ marginBottom: 16 }}>
        Everything else in the console works without them. Once they are set up, researched prospects appear in Leads and their
        email drafts on each lead.
      </p>
      <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 14 }}>
        {steps.map((s) => (
          <li key={s.title} style={{ fontSize: 13.5 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{s.title}</div>
            <div className="staff-note">{s.body}</div>
          </li>
        ))}
      </ol>
      <p className="staff-note" style={{ marginTop: 16 }}>
        Check where it stands any time with <code className="mono">npm run sales:db -- status</code>.
      </p>
    </div>
  );
}
