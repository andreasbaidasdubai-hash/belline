import { redirect } from "next/navigation";
import { hasNoUsers } from "@/lib/store";
import { currentUser } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  seedIfEmpty();

  // Already signed in? Nothing to do here.
  if (await currentUser()) redirect("/");

  // On a fresh install there is nobody to sign in as, so the first visit
  // creates the owner account instead of refusing to let anyone in.
  const firstRun = hasNoUsers();

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: 999,
              background: "var(--accent)",
            }}
          />
          Belline
        </div>
        <p
          className="muted"
          style={{ textAlign: "center", fontSize: 13, margin: "0 0 22px" }}
        >
          {firstRun
            ? "Nobody has set this up yet. Create the owner account."
            : "Sign in to the dashboard"}
        </p>

        <LoginForm firstRun={firstRun} />

        <p
          className="muted"
          style={{ textAlign: "center", fontSize: 11.5, marginTop: 22, lineHeight: 1.55 }}
        >
          {firstRun
            ? "This account can see every venue and add the rest of your team."
            : "Ask whoever set this up if you need an account."}
        </p>
      </div>
    </div>
  );
}
