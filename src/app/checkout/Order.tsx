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
import { overLimitSentence } from "@/lib/billing/speak";
import CheckoutForm from "./CheckoutForm";
import PayButton from "./PayButton";
import {
  NEXT_STEPS,
  VAT_NOTE,
  chooseCycle,
  choosePlan,
  initialOrder,
  orderSearch,
  toggleEditing,
  trialAllowance,
  voiceAllowance,
} from "./order-state";

/**
 * The order: the plan in one line, the price, and what is due.
 *
 * The plan arrives chosen — from the pricing page's link, or the one we
 * recommend — so it is shown as a summary with an Edit button rather than as
 * a price table to choose from all over again. What the plan includes sits
 * behind "What's included": the form beside it is what this page is for.
 * Every number comes from `plans.ts`, in the market's own currency.
 */

// The brand display face from public/brand/tokens.css: SF Pro Display on Apple
// devices, Inter elsewhere, 600 at these sizes.
const serif = { fontFamily: "var(--bl-font-display)", fontWeight: 600, letterSpacing: "var(--bl-track-display)" } as const;

/** "250 voice min · 600 text conversations · 5 users", or an older product's per-channel list, live channels only. */
function shortAllowances(product: Product, video: boolean): string {
  if (product.pools) {
    const parts: string[] = [];
    if (product.pools.minutes) parts.push(voiceAllowance(product.pools.minutes, video, true));
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

const small = { fontSize: 11.5, margin: "8px 0 0", lineHeight: 1.6 } as const;

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
  siteOrigin,
  verifyBy,
  video = false,
  included,
}: {
  /** Each plan's "What's included" lines, read on the server (flags decide some of them). */
  included?: Partial<Record<ProductId, string[]>>;
  /** The video receptionist is live (plans.ts `videoLive`): allowances name video minutes too. */
  video?: boolean;
  market: Market;
  initial: ProductId[];
  initialCycle: BillingCycle;
  signedIn: boolean;
  venueName: string;
  stripe: boolean;
  coveredNote?: string;
  cancelled: boolean;
  /** The countries a business can sign up in today. */
  markets: Market[];
  /** The marketing site for this environment (lib/origin.ts `siteOrigin`). */
  siteOrigin: string;
  /** How the address is confirmed here: by an emailed code, or by the team. */
  verifyBy: "email" | "team";
}) {
  const plans = sellable(market);
  const [order, setOrder] = useState(() => initialOrder(initial[0] ?? plans[0].id, initialCycle));
  const { selected, cycle, editing } = order;

  const ids = [selected];
  const money = (minor: number) => formatMoney(minor, market);
  const fee = periodFee(ids, market, cycle);
  const plan = productById(selected);
  // From the stored annual prices, never a figure typed here.
  const saved = Math.min(...plans.map((p) => annualMonthsSaved([p.id], market)));
  const savedText = saved > 0 ? `${saved} month${saved === 1 ? "" : "s"} free` : "";

  // The choice lives in the URL too, so an order can be sent to somebody.
  useEffect(() => {
    window.history.replaceState(null, "", orderSearch(window.location.search, order));
  }, [order]);

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
              onClick={() => setOrder((o) => chooseCycle(o, c))}
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

        <h1 style={{ ...serif, fontSize: 25, letterSpacing: "-0.02em", margin: "0 0 12px" }}>Your plan</h1>

        <div
          data-plan-summary
          style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "14px 16px", border: "1px solid var(--border)", borderRadius: 10 }}
        >
          <div style={{ minWidth: 0 }}>
            <strong style={{ fontSize: 15 }}>Belline {plan.name}</strong>
            <span style={{ ...serif, display: "block", fontSize: 18, marginTop: 2 }}>
              {priceLine(selected)}
              {cycle === "annual" && <span className="muted" style={{ fontFamily: "var(--bl-font-text)", fontWeight: 400, fontSize: 12 }}> billed yearly</span>}
            </span>
            <span className="muted" style={{ display: "block", fontSize: 12, marginTop: 4 }}>
              {shortAllowances(plan, video)}
            </span>
          </div>
          {plans.length > 1 && (
            <button
              type="button"
              className="btn"
              aria-expanded={editing}
              aria-controls="plan-editor"
              onClick={() => setOrder(toggleEditing)}
              style={{ flex: "none", padding: "6px 14px", fontSize: 12.5 }}
            >
              {editing ? "Done" : "Edit"}
            </button>
          )}
        </div>

        {editing && (
          <div id="plan-editor" style={{ display: "grid", gap: 8, marginTop: 10 }} role="radiogroup" aria-label="Plan">
            {plans.map((p) => {
              const on = p.id === selected;
              return (
                <button key={p.id} type="button" role="radio" aria-checked={on} onClick={() => setOrder((o) => choosePlan(o, p.id))} style={choice(on)}>
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
                    {shortAllowances(p, video)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>What&rsquo;s included</summary>
          <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0", lineHeight: 1.55 }}>
            Phone, website voice button, website chat and WhatsApp in every plan, per location.
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 4px" }}>
            {(included?.[selected] ?? publicLines(plan)).map((line) => (
              <li key={line} style={{ position: "relative", paddingLeft: 19, marginBottom: 7, fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
                <span aria-hidden="true" style={{ position: "absolute", left: 0, top: "0.62em", width: 8, height: 1, background: "var(--gold-ink)" }} />
                {line}
              </li>
            ))}
          </ul>
        </details>

        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>Due today</span>
            <span style={{ ...serif, fontSize: 21, letterSpacing: "-0.015em" }}>{money(signedIn ? fee : 0)}</span>
          </div>
          {!signedIn && (
            <p data-trial-allowance style={{ fontSize: 12.5, margin: "8px 0 0", lineHeight: 1.5, color: "var(--text-2)" }}>
              Free trial: {trialAllowance(TRIAL, video)}. No card.
            </p>
          )}
          <p className="muted" style={small}>
            {!signedIn
              ? `Then ${money(fee)} ${cycle === "annual" ? "a year" : "a month"}, only if you choose a plan. ${VAT_NOTE}`
              : cycle === "annual"
                ? `${money(fee)} a year — ${money(annualPerMonth(ids, market))} a month. ${VAT_NOTE}`
                : `Or ${money(periodFee(ids, market, "annual"))} billed yearly (${money(annualPerMonth(ids, market))} a month)${savedText ? ` — ${savedText}` : ""}. ${VAT_NOTE}`}
          </p>
          <p className="muted" style={{ ...small, marginTop: 6 }}>
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
            <p className="muted" style={{ fontSize: 13, margin: "0 0 10px", lineHeight: 1.55 }}>
              Start with your account. No card until you choose a plan.
            </p>
            <ol
              aria-label="What happens next"
              style={{ listStyle: "none", padding: 0, margin: "0 0 22px", display: "flex", flexWrap: "wrap", gap: "4px 6px", fontSize: 12, color: "var(--text-2)" }}
            >
              {NEXT_STEPS.map((step, i) => (
                <li key={step} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span style={i === 0 ? { color: "var(--text)", fontWeight: 600 } : undefined}>{step}</span>
                  {i < NEXT_STEPS.length - 1 && <span aria-hidden="true">→</span>}
                </li>
              ))}
            </ol>
            <CheckoutForm products={ids} market={market} markets={markets} siteOrigin={siteOrigin} verifyBy={verifyBy} />
          </>
        )}

        <p className="muted" style={{ fontSize: 11, margin: "18px 0 0", textAlign: "center", lineHeight: 1.65 }}>
          {stripe ? "Secure checkout by Stripe · " : ""}Cancel anytime
        </p>
      </section>
    </>
  );
}
