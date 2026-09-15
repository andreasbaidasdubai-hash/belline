import Brand from "@/components/Brand";
import { peekResetToken } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import ResetForm from "./ResetForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "Set a new password" };

/**
 * Where a reset link lands. Opening the page does not use the link up; saving
 * the new password does. Not redirected when signed in: somebody signed in on
 * a shared computer may still want to change it.
 */
export default async function ResetPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  seedIfEmpty();
  const { t } = await searchParams;
  const token = typeof t === "string" ? t.slice(0, 400) : "";
  const valid = Boolean(peekResetToken(token));

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <Brand size={30} />
        </div>
        <h1 className="muted" style={{ textAlign: "center", fontSize: 13, fontWeight: 400, margin: "0 0 22px" }}>
          Set a new password
        </h1>
        {valid ? (
          <ResetForm token={token} />
        ) : (
          <div className="panel" style={{ padding: 22, fontSize: 13.5, lineHeight: 1.6 }}>
            This link has expired or has already been used.{" "}
            <a href="/login/forgot" style={{ color: "var(--accent)", textDecoration: "underline" }}>
              Ask for a new one
            </a>
            .
          </div>
        )}
      </div>
    </main>
  );
}
