import { redirect } from "next/navigation";
import Brand from "@/components/Brand";
import { currentUser } from "@/lib/auth-server";
import { resetMode } from "@/lib/auth-reset";
import { seedIfEmpty } from "@/lib/seed";
import ForgotForm from "./ForgotForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "Forgot your password" };

/**
 * Forgot password. With email switched on this sends a reset link; with it
 * off, it says plainly that the team will check it is you, rather than
 * promising an email that is never sent.
 */
export default async function ForgotPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  seedIfEmpty();
  if (await currentUser()) redirect("/");
  const { email } = await searchParams;
  const mode = resetMode();

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <Brand size={30} />
        </div>
        <h1 className="muted" style={{ textAlign: "center", fontSize: 13, fontWeight: 400, margin: "0 0 22px" }}>
          {mode === "email" ? "Get a link to set a new password" : "Get help signing in"}
        </h1>
        <ForgotForm mode={mode} initialEmail={typeof email === "string" ? email.slice(0, 254) : ""} />
        <p className="muted" style={{ textAlign: "center", fontSize: 11.5, marginTop: 22, lineHeight: 1.55 }}>
          Remembered it? <a href="/login" style={{ color: "var(--accent)", textDecoration: "underline" }}>Sign in</a>
        </p>
      </div>
    </main>
  );
}
