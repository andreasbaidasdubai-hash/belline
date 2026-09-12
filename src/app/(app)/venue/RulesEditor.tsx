"use client";

import type { BookingPolicy } from "@/lib/types";
import { Cell, ClockBox, Field, NumberBox, Panel, Toggle } from "./fields";

/**
 * The house rules.
 *
 * Everything here is a sentence the agent will say to a stranger, so the hints
 * quote the consequence rather than describing the field. "24 hours" is not a
 * setting, it is the moment somebody is told they have missed the window.
 *
 * Every rule is optional and blank means no rule — the state a venue is in
 * before it has thought about any of this, and the state the engine behaved in
 * before these existed.
 */

const HOURS = [
  { label: "no notice needed", value: undefined },
  { label: "20 minutes", value: 20 },
  { label: "1 hour", value: 60 },
  { label: "2 hours", value: 120 },
  { label: "4 hours", value: 240 },
  { label: "12 hours", value: 720 },
  { label: "24 hours", value: 1440 },
  { label: "48 hours", value: 2880 },
];

export default function RulesEditor({
  policy,
  onChange,
  currency,
  guestsWord,
  problems,
}: {
  policy: BookingPolicy;
  onChange: (next: BookingPolicy) => void;
  currency: string;
  guestsWord: string;
  problems: Map<string, string>;
}) {
  function set<K extends keyof BookingPolicy>(key: K, value: BookingPolicy[K]) {
    const next = { ...policy, [key]: value };
    if (value === undefined) delete next[key];
    onChange(next);
  }

  const deposit = policy.deposit;

  function setDeposit(patch: Partial<NonNullable<BookingPolicy["deposit"]>>) {
    onChange({
      ...policy,
      deposit: { amount: 0, per: "booking", ...deposit, ...patch },
    });
  }

  return (
    <>
      <Panel
        title="When a booking may be taken"
        hint="Separate from whether a table or a chair is free. This is the business deciding, not the room."
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 22 }}>
          <div style={{ minWidth: 240, flex: 1 }}>
            <Field
              label="Notice needed"
              hint="How far ahead of the booking somebody has to ring. Anything inside this is refused with the earliest time that would work."
              problem={problems.get("policy.minNoticeMin")}
            >
              <select
                value={String(policy.minNoticeMin ?? "")}
                onChange={(e) =>
                  set("minNoticeMin", e.target.value === "" ? undefined : Number(e.target.value))
                }
              >
                {HOURS.map((h) => (
                  <option key={h.label} value={h.value === undefined ? "" : String(h.value)}>
                    {h.label}
                  </option>
                ))}
                {policy.minNoticeMin !== undefined &&
                  !HOURS.some((h) => h.value === policy.minNoticeMin) && (
                    <option value={String(policy.minNoticeMin)}>
                      {policy.minNoticeMin} minutes
                    </option>
                  )}
              </select>
            </Field>
          </div>

          <div style={{ minWidth: 240, flex: 1 }}>
            <Field
              label="How far ahead you take bookings"
              hint="Beyond this the agent says the date is not open yet, and takes a message instead of guessing."
              problem={problems.get("policy.maxHorizonDays")}
            >
              <NumberBox
                value={policy.maxHorizonDays}
                onChange={(v) => set("maxHorizonDays", v)}
                suffix="days"
                placeholder="90"
              />
            </Field>
          </div>

          <div style={{ minWidth: 240, flex: 1 }}>
            <Field
              label="Stop taking today's bookings at"
              hint="Not the same as a notice period: a kitchen that stops at four is saying the ordering is done, not that it needs four hours."
              problem={problems.get("policy.sameDayCutoffMin")}
            >
              <ClockBox
                value={policy.sameDayCutoffMin}
                onChange={(v) => set("sameDayCutoffMin", v)}
                width={140}
              />
            </Field>
          </div>
        </div>
      </Panel>

      <Panel
        title="Cancellations and no-shows"
        hint="Belline never charges anybody. It states the policy at the moment it applies and marks the booking, so you can decide."
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 22 }}>
          <div style={{ minWidth: 220, flex: 1 }}>
            <Field
              label="Cancellation window"
              hint="Cancel inside this and the booking is marked late, and the agent says so on the call."
              problem={problems.get("policy.cancellationWindowHours")}
            >
              <NumberBox
                value={policy.cancellationWindowHours}
                onChange={(v) => set("cancellationWindowHours", v)}
                suffix="hours before"
                placeholder="24"
              />
            </Field>
          </div>
          <div style={{ minWidth: 200, flex: 1 }}>
            <Field
              label="Late cancellation charge"
              hint="Quoted, not taken. Leave blank to state the window without mentioning money."
            >
              <NumberBox
                value={policy.lateCancelFee}
                onChange={(v) => set("lateCancelFee", v)}
                suffix={currency}
              />
            </Field>
          </div>
          <div style={{ minWidth: 200, flex: 1 }}>
            <Field label="No-show charge" hint="Recorded against the booking for you to act on.">
              <NumberBox value={policy.noShowFee} onChange={(v) => set("noShowFee", v)} suffix={currency} />
            </Field>
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 22 }}>
          <div style={{ minWidth: 260, flex: 1 }}>
            <Field
              label="Hand to a person after this many no-shows"
              hint={`The agent takes the request and says somebody will confirm — it never tells a ${guestsWord.replace(/s$/, "")} they are on a list. Blank means it never does this.`}
            >
              <NumberBox
                value={policy.noShowsBeforeReview}
                onChange={(v) => set("noShowsBeforeReview", v)}
                suffix="no-shows"
              />
            </Field>
          </div>
          <div style={{ minWidth: 260, flex: 1 }}>
            <Field
              label={`Most open bookings one ${guestsWord.replace(/s$/, "")} may hold`}
              hint="A backstop against one number filling the diary. Blank means no limit."
            >
              <NumberBox
                value={policy.maxOpenPerGuest}
                onChange={(v) => set("maxOpenPerGuest", v)}
                suffix="at a time"
              />
            </Field>
          </div>
        </div>
      </Panel>

      <Panel
        title="Deposits"
        hint="Worked out and said on the call. Belline will not take a card number over the phone, so the wording sends them to you."
      >
        <Toggle
          checked={Boolean(deposit)}
          label="Ask for a deposit on some bookings"
          onChange={(on) =>
            onChange({
              ...policy,
              deposit: on ? { amount: 50, per: "booking" } : undefined,
            })
          }
        />

        {deposit && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-end" }}>
              <Cell label="Amount" width={130}>
                <NumberBox
                  value={deposit.amount}
                  onChange={(v) => setDeposit({ amount: v ?? 0 })}
                  suffix={currency}
                  width={70}
                />
              </Cell>
              <Cell label="Charged" width={160}>
                <select
                  value={deposit.per}
                  onChange={(e) => setDeposit({ per: e.target.value === "person" ? "person" : "booking" })}
                >
                  <option value="booking">per booking</option>
                  <option value="person">per person</option>
                </select>
              </Cell>
              <Cell label="Only for parties of" width={150}>
                <NumberBox
                  value={deposit.minPartySize}
                  onChange={(v) => setDeposit({ minPartySize: v })}
                  suffix="or more"
                  width={60}
                />
              </Cell>
              <Cell label="Only over" width={150}>
                <NumberBox
                  value={deposit.minValue}
                  onChange={(v) => setDeposit({ minValue: v })}
                  suffix={currency}
                  width={70}
                />
              </Cell>
              <div style={{ paddingBottom: 9 }}>
                <Toggle
                  checked={Boolean(deposit.newGuestsOnly)}
                  label="First visits only"
                  onChange={(v) => setDeposit({ newGuestsOnly: v })}
                />
              </div>
            </div>

            <Field
              label="What the agent says about it"
              hint="Your words, said once, at the point the booking is made — not while somebody is still choosing a time."
            >
              <textarea
                rows={2}
                value={deposit.wording ?? ""}
                placeholder={`There is a ${currency} ${deposit.amount} deposit on this booking. The team will send a link to settle it.`}
                onChange={(e) => setDeposit({ wording: e.target.value || undefined })}
              />
            </Field>
          </div>
        )}
      </Panel>
    </>
  );
}
