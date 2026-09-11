import { query } from "../db/client";
import type { Channel } from "./types";

/**
 * Product analytics, from the first commit.
 *
 * Retrofitted analytics are always worse, and in this product they are also
 * commercially load-bearing: the sentence a customer renews on is "Belline
 * handled 312 conversations this month, booked 47 appointments and resolved
 * 86% without anyone stepping in", and that sentence has to be a query rather
 * than a reconstruction.
 *
 * One table, one function, a jsonb payload — so a new event is a call rather
 * than a migration.
 *
 * `trace_id` is the other half of why this exists. It threads a webhook
 * through the model call, the tool call and the reply, which is what makes
 * "why did it answer that?" answerable three weeks later instead of a shrug.
 */

export interface TrackInput {
  tenantId: string;
  businessId?: string;
  locationId?: string;
  channel?: Channel;
  conversationId?: number;
  traceId?: string;
  name: string;
  payload?: Record<string, unknown>;
}

/**
 * Record an event.
 *
 * Never throws. An analytics write that fails must not take a customer's
 * booking down with it — the event is the least important thing happening in
 * any request that produces one.
 */
export async function track(input: TrackInput): Promise<void> {
  try {
    await query(
      `insert into event
         (tenant_id, business_id, location_id, channel, conversation_id, trace_id, name, payload)
       values ($1,$2,$3,$4,$5,$6,$7,coalesce($8::jsonb,'{}'::jsonb))`,
      [
        input.tenantId,
        input.businessId ?? null,
        input.locationId ?? null,
        input.channel ?? null,
        input.conversationId ?? null,
        input.traceId ?? null,
        input.name,
        input.payload ? JSON.stringify(input.payload) : null,
      ],
    );
  } catch (err) {
    console.error(`[events] ${input.name} not recorded:`, (err as Error).message);
  }
}

/** A short id for threading one request through the logs. */
export function newTraceId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
