import type { BillingCycle, ProductId } from "@/lib/billing/plans";

/**
 * The checkout's order, as plain functions so a check can hold them.
 *
 * The page reads `?cycle=` once; after that the cycle is the visitor's, and
 * opening the plan editor and picking another plan must not quietly put an
 * annual order back to monthly — which is the bug a component that re-derives
 * its cycle from the chosen plan would have.
 */

export interface OrderState {
  selected: ProductId;
  cycle: BillingCycle;
  /** The plan list is open for a change of plan. */
  editing: boolean;
}

/** `?cycle=annual` preselects annual; anything else is monthly. */
export function cycleFromParam(value: string | undefined): BillingCycle {
  return value === "annual" ? "annual" : "monthly";
}

export function initialOrder(selected: ProductId, cycle: BillingCycle): OrderState {
  return { selected, cycle, editing: false };
}

/** Pick a plan from the editor: the plan changes, the cycle stays, the editor closes. */
export function choosePlan(state: OrderState, id: ProductId): OrderState {
  return { ...state, selected: id, editing: false };
}

export function chooseCycle(state: OrderState, cycle: BillingCycle): OrderState {
  return { ...state, cycle };
}

export function toggleEditing(state: OrderState): OrderState {
  return { ...state, editing: !state.editing };
}

/** The address bar after a change, so an order can be sent to somebody. */
export function orderSearch(search: string, state: OrderState): string {
  const params = new URLSearchParams(search);
  params.delete("bundle");
  params.delete("plan");
  params.set("products", state.selected);
  if (state.cycle === "annual") params.set("cycle", "annual");
  else params.delete("cycle");
  return `?${params.toString()}`;
}

/** The trial in the catalogue's own numbers: "30 days, 30 voice minutes, 50 text conversations". */
export function trialAllowance(trial: { days: number; minutes: number; conversations: number }): string {
  return `${trial.days} days, ${trial.minutes} voice minutes, ${trial.conversations} text conversations`;
}

/** The sign-up steps, in the order they happen after this page. */
export const NEXT_STEPS = ["Create your account", "Confirm your email", "Add your business", "Test Belle", "Go live"] as const;

/** Matches the terms: "Prices exclude VAT where it applies." */
export const VAT_NOTE = "Prices exclude VAT where it applies.";
