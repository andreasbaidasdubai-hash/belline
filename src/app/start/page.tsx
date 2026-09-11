import { redirect } from "next/navigation";
import Brand from "@/components/Brand";
import { currentUser } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import StartForm from "./StartForm";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Get Belline",
  description: "Create your Belline account. Fourteen days free, no card.",
};

/**
 * Where "Get Belline" lands.
 *
 * Four fields and no card, because everything else a form could ask is
 * something the next screen can read off their website. The fastest way to
 * lose a salon owner is to open with a page that looks like paperwork.
 */
export default async function StartPage() {
  seedIfEmpty();

  // Already signed in — they pressed the button out of habit.
  if (await currentUser()) redirect("/setup");

  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ maxWidth: 460 }}>
        <div className="auth-brand">
          <Brand size={30} />
        </div>

        <h1
          style={{
            fontFamily: '"Fraunces", Georgia, serif',
            fontWeight: 500,
            fontSize: 28,
            letterSpacing: "-0.02em",
            lineHeight: 1.1,
            textAlign: "center",
            margin: "0 0 8px",
          }}
        >
          Someone always answers.
        </h1>
        <p
          className="muted"
          style={{ textAlign: "center", fontSize: 13.5, margin: "0 0 26px", lineHeight: 1.55 }}
        >
          Fourteen days free. No card.
        </p>

        <StartForm />

        <p
          className="muted"
          style={{ textAlign: "center", fontSize: 11.5, marginTop: 22, lineHeight: 1.6 }}
        >
          Already have an account? <a href="/login">Sign in</a>
        </p>
      </div>
    </div>
  );
}
