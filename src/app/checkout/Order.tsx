"use client";

import { useEffect, useState } from "react";
import {
  CHANNELS,
  CHANNEL_ORDER,
  TRIAL,
  annualPerMonth,
  checkSelection,
  isFreeSelection,
  periodFee,
  productById,
  publicLines,
  selectionName,
  sellable,
  type BillingCycle,
  type Channel,
  type Product,
  type ProductId,
} from "@/lib/billing/plans";
import { formatMoney, type Market } from "@/lib/markets";
import CheckoutForm from "./CheckoutForm";
import PayButton from "./PayButton";

/**
 * The order: a bundle first, then modules as toggles, and a total that moves.
 *
 * Bundles lead because they are the card we want picked — every channel at
 * one price — and a clinic that wants everything should not have to assemble
 * it. Below them, one row per channel for the restaurant that only wants the
 * chat. Choosing a module leaves the bundle; choosing a bundle clears the
 * modules; two options on one channel is not a thing somebody can select.
 *
 * Every number comes from `plans.ts`, in the market's own currency, and the
 * same `checkSelection` the API and the Stripe webhook use decides what is
 * valid — so the page cannot offer something the server will refuse.
 */

const serif = { fontFamily: '"Fraunces", Georgia, serif', fontWeight: 500 } as const;

function channelOf(product: Product): Channel {
  return CHANNEL_ORDER.find((c) => c in product.allowances)!;
}

/** "600 phone min · 200 voice-button min · 400 chats", live channels only. */
function shortAllowances(product: Product): string {
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
    padding: "11px 13px",
  };
}

export default function Order({
  market,
  initial,
  initialCycle,
  signedIn,
  venueName,
  stripe,
  cancelled,
}: {
  market: Market;
  initial: ProductId[];
  initialCycle: BillingCycle;
  signedIn: boolean;
  venueName: string;
  stripe: boolean;
  cancelled: boolean;
}) {
  const [selected, setSelected] = useState<ProductId[]>(initial);
  const [cycle, setCycle] = useState<BillingCycle>(initialCycle);

  const options = sellable(market);
  const bundles = options.filter((p) => p.kind === "bundle");
  const money = (minor: number) => formatMoney(minor, market);
  const isBundle = selected.length === 1 && productById(selected[0]).kind === "bundle";

  const valid = checkSelection(selected, market);
  const ids = valid.ok ? valid.products : [];
  const fee = ids.length ? periodFee(ids, market, cycle) : 0;
  const free = ids.length > 0 && isFreeSelection(ids);
  const lines = [...new Set(ids.flatMap((id) => publicLines(productById(id))))];

  // The selection lives in the URL too, so an order can be sent to somebody.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete("bundle");
    params.delete("plan");
    if (selected.length) params.set("products", selected.join(","));
    else params.delete("products");
    if (cycle === "annual") params.set("cycle", "annual");
    else params.delete("cycle");
    window.history.replaceState(null, "", `?${params.toString()}`);
  }, [selected, cycle]);

  function toggle(id: ProductId) {
    const channel = channelOf(productById(id));
    setSelected((prev) => {
      const base = isBundle ? [] : prev;
      const others = base.filter((x) => channelOf(productById(x)) !== channel);
      return base.includes(id) ? others : [...others, id];
    });
  }

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
              {c === "monthly" ? "Monthly" : "Annual · 2 months free"}
            </button>
          ))}
        </div>

        <h1 style={{ ...serif, fontSize: 25, letterSpacing: "-0.02em", margin: "0 0 4px" }}>Everything</h1>
        <p className="muted" style={{ fontSize: 13, margin: "0 0 12px", lineHeight: 1.55 }}>
          Every channel for one venue, at one price.
        </p>
        <div style={{ display: "grid", gap: 8, marginBottom: 26 }}>
          {bundles.map((b) => {
            const on = isBundle && selected[0] === b.id;
            return (
              <button key={b.id} type="button" aria-pressed={on} onClick={() => setSelected([b.id])} style={choice(on)}>
                <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <strong style={{ fontSize: 14.5 }}>
                    {b.name}
                    {b.recommended && (
                      <span style={{ marginLeft: 8, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--gold-ink)" }}>
                        Most popular
                      </span>
                    )}
                  </strong>
                  <span style={{ ...serif, fontSize: 17, whiteSpace: "nowrap" }}>{priceLine(b.id)}</span>
                </span>
                <span className="muted" style={{ display: "block", fontSize: 12, marginTop: 4 }}>
                  {shortAllowances(b)}
                </span>
              </button>
            );
          })}
        </div>

        <h2 style={{ ...serif, fontSize: 19, letterSpacing: "-0.015em", margin: "0 0 4px" }}>Or only what you need</h2>
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 12px" }}>One option per channel.</p>
        {CHANNEL_ORDER.map((channel) => {
          const modules = options.filter((p) => p.kind === "module" && channelOf(p) === channel);
          if (!modules.length) return null;
          return (
            <div key={channel} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{CHANNELS[channel].name}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {modules.map((m) => {
                  const on = !isBundle && selected.includes(m.id);
                  return (
                    <button key={m.id} type="button" aria-pressed={on} onClick={() => toggle(m.id)} style={{ ...choice(on), padding: "8px 11px", fontSize: 12.5 }}>
                      {shortAllowances(m)} · <strong>{m.free ? "Free" : priceLine(m.id)}</strong>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 22, paddingTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{ids.length ? selectionName(ids) : "Nothing chosen yet"}</div>
          {!valid.ok && selected.length > 0 && (
            <p role="alert" style={{ fontSize: 12.5, color: "var(--bad)", margin: "6px 0 0" }}>
              {valid.error}
            </p>
          )}
          {lines.length > 0 && (
            <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 16px" }}>
              {lines.map((line) => (
                <li key={line} style={{ position: "relative", paddingLeft: 19, marginBottom: 7, fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
                  <span aria-hidden="true" style={{ position: "absolute", left: 0, top: "0.62em", width: 8, height: 1, background: "var(--gold-ink)" }} />
                  {line}
                </li>
              ))}
            </ul>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", paddingTop: 12, borderTop: "1px solid var(--border-soft)" }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>Due today</span>
            <span style={{ ...serif, fontSize: 21, letterSpacing: "-0.015em" }}>{money(signedIn ? fee : 0)}</span>
          </div>
          <p className="muted" style={{ fontSize: 11.5, margin: "8px 0 0", lineHeight: 1.6 }}>
            {!signedIn
              ? `${TRIAL.days} days free with every channel switched on, and no card. ${ids.length && !free ? `Then ${money(fee)} ${cycle === "annual" ? "a year" : "a month"}, if you choose it.` : ""}`
              : free
                ? `No card, no end date. Up to ${(productById("chat_free").allowances.chat as number).toLocaleString("en-GB")} conversations a month; the chat pauses when they are used.`
                : cycle === "annual"
                  ? `${money(fee)} a year — ${money(annualPerMonth(ids, market))} a month. Plus VAT where it applies.`
                  : ids.length
                    ? `Or ${money(annualPerMonth(ids, market))} a month paid annually — two months free. Plus VAT where it applies.`
                    : ""}
          </p>
          {!free && (
            <p className="muted" style={{ fontSize: 11.5, margin: "6px 0 0", lineHeight: 1.6 }}>
              No per-minute charges. If an allowance runs short, Belline keeps answering and suggests a bigger plan.
            </p>
          )}
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
            <h2 style={{ ...serif, fontSize: 21, letterSpacing: "-0.015em", margin: "0 0 6px" }}>
              {free ? "Switch to the free chat" : "Add a card"}
            </h2>
            <p className="muted" style={{ fontSize: 13, margin: "0 0 22px", lineHeight: 1.55 }}>
              For {venueName}.
            </p>
            <PayButton products={ids} cycle={cycle} enabled={stripe} venueName={venueName} free={free} />
          </>
        ) : (
          <>
            <h2 style={{ ...serif, fontSize: 21, letterSpacing: "-0.015em", margin: "0 0 6px" }}>Someone always answers.</h2>
            <p className="muted" style={{ fontSize: 13, margin: "0 0 22px", lineHeight: 1.55 }}>
              Four things and you are set up. No card until you choose a plan.
            </p>
            <CheckoutForm products={ids} market={market} />
          </>
        )}

        <p className="muted" style={{ fontSize: 11, margin: "18px 0 0", textAlign: "center", lineHeight: 1.65 }}>
          {stripe ? "Secure checkout by Stripe · " : ""}Cancel anytime
          <br />
          Several venues? <a href="mailto:hello@belline.ai">Email us</a> and we will price it properly.
        </p>
      </section>
    </>
  );
}
