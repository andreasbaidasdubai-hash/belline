import Brand from "@/components/Brand";
import SignInButton from "./SignInButton";

export const dynamic = "force-dynamic";

export const metadata = { title: "This business already has Belline" };

/**
 * Where a refused second trial points (lib/abuse/review.ts).
 *
 * Plain and public: it says what happened and the two ways on, and nothing
 * about which account matched — that is somebody else's business until the
 * team has checked.
 */
export default async function AccountExistsPage({ searchParams }: { searchParams: Promise<{ why?: string }> }) {
  const paused = (await searchParams).why === "paused";
  if (paused) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <div className="auth-brand">
            <Brand size={30} />
          </div>
          <h1 style={{ textAlign: "center", fontSize: 18, fontWeight: 600, margin: "0 0 10px" }}>Your free trial is paused</h1>
          <div className="panel" style={{ padding: 22, fontSize: 13.5, lineHeight: 1.6 }}>
            <p style={{ margin: "0 0 18px" }}>
              The Belline team has paused the free trial on this account while they check something. Write to us and
              we&apos;ll sort it out.
            </p>
            <a href="mailto:hello@belline.ai?subject=My%20Belline%20trial" className="btn btn-accent">
              Contact us
            </a>
          </div>
        </div>
      </main>
    );
  }
  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <Brand size={30} />
        </div>
        <h1 style={{ textAlign: "center", fontSize: 18, fontWeight: 600, margin: "0 0 10px" }}>
          This business already has a Belline account
        </h1>
        <div className="panel" style={{ padding: 22, fontSize: 13.5, lineHeight: 1.6 }}>
          <p style={{ margin: "0 0 12px" }}>
            Its website, phone number or card is already on another Belline account, and each business gets one free
            trial. So this account can&apos;t start a second one.
          </p>
          <p style={{ margin: "0 0 18px" }}>
            If that account is yours, sign in to it. If you think this is a mistake, or you run a separate business at
            the same address, write to us and we&apos;ll sort it out.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <SignInButton />
            <a href="mailto:hello@belline.ai?subject=My%20Belline%20trial" className="btn">
              Contact us
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
