"use client";

import { useEffect, useState } from "react";
import {
  CHANNELS,
  CHANNEL_ORDER,
  TRIAL,
  annualMonthsSaved,
  annualPerMonth,
  periodFee,
  productById,
  publicLines,
  sellable,
  type BillingCycle,
  type Product,
  type ProductId,
} from "@/lib/billing/plans";
import { formatMoney, type Market } from "@/lib/markets";
import type { Vertical } from "@/lib/types";
import { overLimitSentence } from "@/lib/billing/speak";
import CheckoutForm from "./CheckoutForm";
import PayButton from "./PayButton";

/**
 * The order: three plans, one choice, and a total that moves.
 *
 * Every plan has every channel; they differ only in how much. So the page
 * asks one question — which size — and shows what that size includes. Every
 * number comes from `plans.ts`, in the market's own currency.
 */

// The brand display face: Plus Jakarta Sans, 600 at these sizes (loaded in
// src/app/layout.tsx), with the text face and system fonts behind it.
const serif = { fontFamily: '"Plus Jakarta Sans", "Inter", ui-sans-serif, system-ui, sans-serif', fontWeight: 600, letterSpacing: "-0.025em" } as const;

/** "250 voice min · 600 text conversations", or an older product's per-channel list, live channels only. */
function shortAllowances(product: Product): string {
  if (product.pools) {
    const parts: string[] = [];
    if (product.pools.minutes) parts.push(`${product.pools.minutes.toLocaleString("en-GB")} voice min`);
    if (product.pools.conversations) parts.push(`${product.pools.conversations.toLocaleString("en-GB")} text conversations`);
    if (product.users) parts.push(`${product.users} users`);
    return parts.join(" · ");
  }
  return CHANNEL_ORDER.filter((c) => typeof product.allowances[c] === "number" && CHANNELS[c].status === "live")
    .map((c) => {
      const n = (product.allowances[c] as number).toLocaleString("en-GB");
      return c === "phone" ? `${n} phone min` : c === "web_voice" ? `${n} voice-button min` : c === "chat" ? `${n} chats` : `${n} WhatsApp`;
    })
    .join(" · ");
}

function choice(on: boolean): React.CSSProperties {
  return {
    textAlign: "left",
    font: "inherit",
    color: "inherit",
    cursor: "pointer",
    background: on ? "var(--panel-2)" : "transparent",
    border: `1px solid ${on ? "var(--text)" : "var(--border)"}`,
    borderRadius: 10,
    padding: "12px 14px",
  };
}

export default function Order({
  market,
  initial,
  initialCycle,
  signedIn,
  venueName,
  stripe,
  coveredNote,
  cancelled,
  markets,
  trade,
}: {
  market: Market;
  initial: ProductId[];
  initialCycle: BillingCycle;
  signedIn: boolean;
  venueName: string;
  stripe: boolean;
  coveredNote?: string;
  cancelled: boolean;
  markets: Market[];
  trade: Vertical | "";
}) {
  const plans = sellable(market);
  const [selected, setSelected] = useState<ProductId>(initial[0] ?? plans[0].id);
  const [cycle, setCycle] = useState<BillingCycle>(initialCycle);

  const ids = [selected];
  const money = (minor: number) => formatMoney(minor, market);
  const fee = periodFee(ids, market, cycle);
  const plan = productById(selected);
  // From the stored annual prices, never a figure typed here.
  const saved = Math.min(...plans.map((p) => annualMonthsSaved([p.id], market)));
  const savedText = saved > 0 ? `${saved} month${saved === 1 ? "" : "s"} free` : "";

  // The choice lives in the URL too, so an order can be sent to somebody.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete("bundle");
    params.delete("plan");
    params.set("products", selected);
    if (cycle === "annual") params.set("cycle", "annual");
    else params.delete("cycle");
    window.history.replaceState(null, "", `?${params.toString()}`);
  }, [selected, cycle]);

  const priceLine = (id: ProductId) =>
    cycle === "annual" ? `${money(annualPerMonth([id], market))}/mo` : `${money(periodFee([id], market, "monthly"))}/mo`;

  return (
    <>
      <section className="checkout-order">
        <div
          role="group"
          aria-label="Billing period"
          style={{ display: "inline-flex", gap: 4, padding: 3, border: "1px solid var(--border)", borderRadius: 999, marginBottom: 20 }}
        >
          {(["monthly", "annual"] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={cycle === c}
              onClick={() => setCycle(c)}
              style={{
                font: "inherit",
                fontSize: 12.5,
                border: 0,
                borderRadius: 999,
                padding: "6px 14px",
                cursor: "pointer",
                background: cycle === c ? "var(--text)" : "transparent",
                color: cycle === c ? "var(--bg)" : "var(--text-2)",
              }}
            >
              {c === "monthly" ? "Monthly" : savedText ? `Annual · ${savedText}` : "Annual"}
            </button>
          ))}
        </div>

        <h1 style={{ ...serif, fontSize: 25, letterSpacing: "-0.02em", margin: "0 0 4px" }}>Choose your plan</h1>
        <p className="muted" style={{ fontSize: 13, margin: "0 0 14px", lineHeight: 1.55 }}>
          Phone, website voice button, website chat and WhatsApp in every plan, per location. Pick how much.
        </p>
        <div style={{ display: "grid", gap: 8, marginBottom: 24 }} role="radiogroup" aria-label="Plan">
          {plans.map((p) => {
            const on = p.id === selected;
            return (
              <button key={p.id} type="button" role="radio" aria-checked={on} onClick={() => setSelected(p.id)} style={choice(on)}>
                <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <strong style={{ fontSize: 15 }}>
                    {p.name}
                    {p.recommended && (
                      <span style={{ marginLeft: 8, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--gold-ink)" }}>
                        Most popular
                      </span>
                    )}
                  </strong>
                  <span style={{ ...serif, fontSize: 18, whiteSpace: "nowrap" }}>{priceLine(p.id)}</span>
                </span>
                <span className="muted" style={{ display: "block", fontSize: 12, marginTop: 4 }}>
                  {shortAllowances(p)}
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Belline {plan.name}</div>
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 16px" }}>
            {publicLines(plan).map((line) => (
              <li key={line} style={{ position: "relative", paddingLeft: 19, marginBottom: 7, fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
                <span aria-hidden="true" style={{ position: "absolute", left: 0, top: "0.62em", width: 8, height: 1, background: "var(--gold-ink)" }} />
                {line}
              </li>
            ))}
          </ul>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", paddingTop: 12, borderTop: "1px solid var(--border-soft)" }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>Due today</span>
            <span style={{ ...serif, fontSize: 21, letterSpacing: "-0.015em" }}>{money(signedIn ? fee : 0)}</span>
          </div>
          <p className="muted" style={{ fontSize: 11.5, margin: "8px 0 0", lineHeight: 1.6 }}>
            {!signedIn
              ? `${TRIAL.days} days free, no card. Then ${money(fee)} ${cycle === "annual" ? "a year" : "a month"}, if you choose it.`
              : cycle === "annual"
                ? `${money(fee)} a year — ${money(annualPerMonth(ids, market))} a month. Plus VAT where it applies.`
                : `Or ${money(periodFee(ids, market, "annual"))} billed yearly (${money(annualPerMonth(ids, market))} a month)${savedText ? ` — ${savedText}` : ""}. Plus VAT where it applies.`}
          </p>
          <p className="muted" style={{ fontSize: 11.5, margin: "6px 0 0", lineHeight: 1.6 }}>
            Priced per location. Setting up is free. {overLimitSentence()}
          </p>
        </div>
      </section>

      <section className="checkout-act">
        {cancelled && (
          <p style={{ fontSize: 12.5, padding: "10px 13px", borderRadius: 9, background: "var(--panel-2)", border: "1px solid var(--border)", margin: "0 0 20px", color: "var(--text-2)" }}>
            Nothing was charged. Pick it up whenever you like.
          </p>
        )}

        {signedIn ? (
          <>
            <h2 style={{ ...serif, fontSize: 21, letterSpacing: "-0.015em", margin: "0 0 6px" }}>Add a card</h2>
            <p className="muted" style={{ fontSize: 13, margin: "0 0 22px", lineHeight: 1.55 }}>
              For {venueName}.
            </p>
            <PayButton products={ids} cycle={cycle} enabled={stripe} venueName={venueName} coveredNote={coveredNote} />
          </>
        ) : (
          <>
            <h2 style={{ ...serif, fontSize: 21, letterSpacing: "-0.015em", margin: "0 0 6px" }}>Someone always answers.</h2>
            <p className="muted" style={{ fontSize: 13, margin: "0 0 22px", lineHeight: 1.55 }}>
              Four things and you are set up. No card until you choose a plan.
            </p>
            <CheckoutForm products={ids} market={market} markets={markets} trade={trade} />
          </>
        )}

        <p className="muted" style={{ fontSize: 11, margin: "18px 0 0", textAlign: "center", lineHeight: 1.65 }}>
          {stripe ? "Secure checkout by Stripe · " : ""}Cancel anytime
        </p>
      </section>
    </>
  );
}
