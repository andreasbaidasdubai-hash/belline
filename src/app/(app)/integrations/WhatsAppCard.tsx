"use client";

import { useState } from "react";
import type { WhatsAppCard as Card } from "@/lib/whatsapp-selfserve";
import ConnectWhatsApp from "./ConnectWhatsApp";
import WhatsAppAssisted from "./WhatsAppAssisted";

/**
 * The WhatsApp card, one state at a time.
 *
 * Every state says what is happening and what, if anything, the owner does
 * next. None of them sends the owner to an email address: things that are
 * ours to fix say so, and a lookup that failed offers a retry.
 */

const pillStyle = (tone: "ok" | "warn" | "bad" | "plain") =>
  tone === "plain" ? undefined : { background: `var(--${tone}-soft)`, color: `var(--${tone})`, borderColor: `var(--${tone})` };

export default function WhatsAppCard({
  locationId,
  venueName,
  card: initial,
  pendingName,
  notifyRequested,
  skipHref,
}: {
  locationId: string;
  venueName: string;
  card: Card;
  /** The display name typed last time, for the code step. */
  pendingName: string | null;
  notifyRequested: boolean;
  /** On the setup step: where "Skip — add WhatsApp later" goes. */
  skipHref?: string;
}) {
  const [card, setCard] = useState<Card>(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(notifyRequested ? "Noted. We'll let you know when it is ready." : null);

  async function retry() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/whatsapp/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId }),
      });
      const data = (await res.json().catch(() => ({}))) as { card?: Card };
      if (res.ok && data.card) setCard(data.card);
      else setNote("Still could not check. Try again in a minute.");
    } catch {
      setNote("Still could not check. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  }

  async function notify() {
    setBusy(true);
    try {
      const res = await fetch("/api/setup/journey", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId, action: "integration", integration: "whatsapp" }),
      });
      setNote(res.ok ? "Noted. We'll let you know when it is ready." : "That did not save. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  const [label, tone] = {
    soon: ["Available — set up with us", "plain"],
    unavailable: ["Couldn't check", "warn"],
    blocked: ["Being fixed", "warn"],
    none: ["Not connected", "plain"],
    pending_code: ["Waiting for the code", "plain"],
    pending_name: ["Meta is reviewing the name", "plain"],
    rejected: ["Needs another try", "bad"],
    live: ["Connected", "ok"],
  }[card.state] as [string, "ok" | "warn" | "bad" | "plain"];

  const text = { fontSize: 13, lineHeight: 1.6, maxWidth: "68ch", margin: 0 } as const;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span className="pill" style={pillStyle(tone)}>
          {label}
        </span>
        {card.state === "live" && (
          <span className="mono" style={{ fontSize: 13.5 }}>
            {card.number}
          </span>
        )}
      </div>

      {card.state === "soon" && (
        <>
          <p className="muted" style={text}>
            WhatsApp works today: Belline answers a second WhatsApp number for {venueName}, which we set up with you, so
            your own WhatsApp stays exactly as it is. Connecting it yourself opens once Meta&apos;s verification is ready.
            Everything else works without it.
          </p>
          <WhatsAppAssisted locationId={locationId} />
          <button className="btn" type="button" style={{ marginTop: 12 }} onClick={notify} disabled={busy || Boolean(note)}>
            Tell me when I can do it myself
          </button>
        </>
      )}

      {card.state === "unavailable" && (
        // Not "Not connected": the number may already be live, and offering to
        // connect it again is how an owner registers it twice.
        <>
          <p role="status" style={text}>
            Belline couldn&apos;t check this business&apos;s WhatsApp just now. Nothing has changed on your number.
          </p>
          <button className="btn" type="button" style={{ marginTop: 12 }} onClick={retry} disabled={busy}>
            {busy ? "Checking…" : "Try again"}
          </button>
        </>
      )}

      {card.state === "blocked" && (
        <p role="status" style={text}>
          {card.message} Your WhatsApp set-up is saved and carries on as soon as it is fixed.
        </p>
      )}

      {(card.state === "none" || card.state === "pending_code") && (
        <>
          <p className="muted" style={text}>
            Belline can answer a WhatsApp number for {venueName} — a second number, so your own WhatsApp stays exactly as it
            is. Type the number, type the code Meta texts to it: about a minute, no Meta account, nothing to install.
          </p>
          <ConnectWhatsApp
            locationId={locationId}
            venueName={venueName}
            pending={card.state === "pending_code" ? { number: card.number, displayName: pendingName ?? venueName } : null}
          />
        </>
      )}

      {card.state === "pending_name" && (
        <>
          <p role="status" style={text}>
            <span className="mono">{card.number}</span> is verified. Meta is checking the name shown on WhatsApp, which
            usually takes a few hours and at most a couple of days. Belline checks for you and answers as soon as it is
            approved. There is nothing for you to do.
          </p>
          <button className="btn" type="button" style={{ marginTop: 12 }} onClick={retry} disabled={busy}>
            {busy ? "Checking…" : "Check now"}
          </button>
        </>
      )}

      {card.state === "rejected" && (
        <>
          <p role="status" style={text}>
            {card.reason}
          </p>
          <button
            className="btn btn-accent"
            type="button"
            style={{ marginTop: 12 }}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await fetch(`/api/whatsapp/number?locationId=${encodeURIComponent(locationId)}`, { method: "DELETE" }).catch(() => null);
              setBusy(false);
              setCard({ state: "none" });
            }}
          >
            Try again
          </button>
        </>
      )}

      {card.state === "live" && (
        <p className="muted" style={text}>
          Belline answers this number on WhatsApp — questions, bookings, changes — and every thread is in your inbox. Put
          it on your website, your Google profile and your Instagram as &ldquo;WhatsApp us&rdquo;. Your own WhatsApp is
          untouched.
        </p>
      )}

      {note && (
        <p role="status" className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>
          {note}
        </p>
      )}
      {skipHref && card.state !== "live" && (
        <p style={{ margin: "14px 0 0", fontSize: 13 }}>
          <a href={skipHref}>Skip — add WhatsApp later</a>
        </p>
      )}
    </div>
  );
}
