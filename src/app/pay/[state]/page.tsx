import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Deposit — Belline",
  robots: { index: false, follow: false },
};

/**
 * Where a guest lands after Stripe's payment page.
 *
 * Deliberately says nothing it cannot know. Arriving here does not prove a
 * payment went through — the webhook decides that — so "paid" thanks them
 * and says a confirmation follows, and "cancelled" says nothing was charged.
 */
export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ state: string }>;
  searchParams: Promise<{ ref?: string }>;
}) {
  const { state } = await params;
  const { ref } = await searchParams;
  const paid = state === "paid";
  const reference = (ref ?? "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 16);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#FBF9F5", color: "#14110D" }}>
      <div style={{ maxWidth: 440 }}>
        <p style={{ fontSize: 11.5, letterSpacing: "0.16em", textTransform: "uppercase", color: "#8A672E", margin: 0 }}>
          Deposit{reference ? ` · ${reference}` : ""}
        </p>
        <h1 style={{ fontFamily: "Fraunces, Georgia, serif", fontWeight: 400, fontSize: 34, lineHeight: 1.1, margin: "12px 0 16px" }}>
          {paid ? "Thank you." : "Nothing was charged."}
        </h1>
        <p style={{ fontSize: 16, lineHeight: 1.55, margin: 0, color: "#4A443C" }}>
          {paid
            ? "Your payment is with the venue. Stripe emails a receipt, and your booking stays as it was."
            : "Your booking is unchanged. Use the link in the text message to pay whenever you are ready, or call the venue."}
        </p>
      </div>
    </main>
  );
}
