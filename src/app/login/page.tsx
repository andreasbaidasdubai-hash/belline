import { redirect } from "next/navigation";
import Brand from "@/components/Brand";
import { hasNoUsers } from "@/lib/store";
import { currentUser } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import LoginForm from "./LoginForm";
import BelleForVisitors from "@/components/BelleForVisitors";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  /** `?email=` from signup's "already has an account" link, to save retyping it. */
  searchParams: Promise<{ email?: string }>;
}) {
  seedIfEmpty();
  const { email } = await searchParams;

  // Already signed in? Nothing to do here.
  if (await currentUser()) redirect("/");

  // On a fresh install there is nobody to sign in as, so the first visit
  // creates the owner account instead of refusing to let anyone in.
  const firstRun = hasNoUsers();

  return (
    <>
    <main className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <Brand size={30} />
        </div>
        <h1
          className="muted"
          style={{ textAlign: "center", fontSize: 13, fontWeight: 400, margin: "0 0 22px" }}
        >
          {firstRun
            ? "Nobody has set this up yet. Create the owner account."
            : "Sign in to the dashboard"}
        </h1>

        <LoginForm firstRun={firstRun} initialEmail={typeof email === "string" ? email.slice(0, 254) : ""} />

        <p
          className="muted"
          style={{ textAlign: "center", fontSize: 11.5, marginTop: 22, lineHeight: 1.55 }}
        >
          {firstRun
            ? "This account can see every venue and add the rest of your team."
            : (
                <>
                  Part of a team? Ask whoever set this up for an account.
                  <br />
                  New to Belline?{" "}
                  <a href="/checkout" style={{ color: "var(--accent)", textDecoration: "underline" }}>
                    Start free
                  </a>
                  .
                </>
              )}
        </p>
      </div>
    </main>
    {/* "I can't sign in": Belle, told this is the sign-in page. */}
    <BelleForVisitors page="login" />
    </>
  );
}
