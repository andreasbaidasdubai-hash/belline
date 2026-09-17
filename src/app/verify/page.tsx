import { redirect } from "next/navigation";
import Brand from "@/components/Brand";
import { requireUser } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { CODE_MINUTES, needsEmailVerification, verifyMode } from "@/lib/email-verify";
import VerifyForm from "./VerifyForm";
import BelleForVisitors from "@/components/BelleForVisitors";

export const dynamic = "force-dynamic";

export const metadata = { title: "Confirm your email — Belline" };

/**
 * Confirm the owner's email address: the first screen after signup.
 *
 * Nothing that costs Belline money runs until this is done (lib/abuse/gate.ts),
 * so the page says so plainly and offers the way on without it: setting up by
 * hand. An account that is already confirmed, or predates confirmation, goes
 * straight to setup.
 */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  if (!needsEmailVerification(user)) redirect("/setup");
  const { code } = await searchParams;
  const mode = verifyMode();

  return (
    <>
    <main className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <Brand size={30} />
        </div>
        <h1 style={{ textAlign: "center", fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>Confirm your email</h1>
        <p className="muted" style={{ textAlign: "center", fontSize: 13, lineHeight: 1.55, margin: "0 0 20px" }}>
          {mode === "email" ? (
            <>
              We sent a 6-digit code to <strong>{user.email}</strong>. It works for {CODE_MINUTES} minutes.
            </>
          ) : (
            <>
              Belline can&apos;t send email from here yet, so the Belline team will confirm <strong>{user.email}</strong> for you,
              usually within a working day.
            </>
          )}
        </p>

        <VerifyForm mode={mode} email={user.email} initialCode={/^\d{6}$/.test(code ?? "") ? code! : ""} />

        <p className="muted" style={{ textAlign: "center", fontSize: 11.5, marginTop: 22, lineHeight: 1.55 }}>
          Until it is confirmed, Belline won&apos;t read your website or run test calls.{" "}
          <a href="/setup" style={{ color: "var(--accent)", textDecoration: "underline" }}>
            Set up by hand meanwhile
          </a>
          .
        </p>
      </div>
    </main>
    {/* "I didn't get the code": Belle, told this is the confirm-your-email page. */}
    <BelleForVisitors page="verify" />
    </>
  );
}
