import type pg from "pg";
import { isUniqueViolation, one, query, tx } from "../db/client";
import type {
  Channel,
  ChannelAccount,
  Conversation,
  ConversationState,
  ConversationStatus,
  Customer,
  Message,
  Provider,
  Sender,
  ContentType,
  DeliveryStatus,
} from "./types";

/**
 * The reception data layer.
 *
 * One rule, applied without exception: **every function takes the tenant id
 * first, and there is no overload that omits it.** Not because an attacker is
 * expected to craft an id, but because the realistic failure is a query
 * written next year by somebody in a hurry, in a codebase where forgetting
 * returns another business's conversations. A signature that makes forgetting
 * impossible is worth more than a review that catches it most of the time.
 *
 * The corollary is that ids are not enough on their own anywhere. Loading a
 * conversation by its primary key still requires the tenant, and a mismatch
 * returns undefined rather than throwing — a caller holding an id from
 * somewhere else should see "no such conversation", which is the truth from
 * where they are standing.
 */

// ---------------------------------------------------------------------------
// Row shapes. Postgres gives snake_case; the domain is camelCase.
// ---------------------------------------------------------------------------

interface CustomerRow {
  id: number;
  tenant_id: string;
  phone_e164: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  language: string | null;
  notes: string | null;
  preferences: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function toCustomer(r: CustomerRow): Customer {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    phoneE164: r.phone_e164,
    firstName: r.first_name ?? undefined,
    lastName: r.last_name ?? undefined,
    email: r.email ?? undefined,
    language: r.language ?? undefined,
    notes: r.notes ?? undefined,
    preferences: r.preferences ?? {},
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

interface ConversationRow {
  id: number;
  tenant_id: string;
  business_id: string;
  location_id: string | null;
  channel: Channel;
  channel_account_id: number | null;
  customer_id: number;
  status: ConversationStatus;
  handoff_reason: string | null;
  handoff_summary: string | null;
  handoff_at: Date | null;
  handoff_user_id: string | null;
  state: ConversationState;
  language: string | null;
  booking_id: string | null;
  call_id: string | null;
  last_message_at: Date;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

function toConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    businessId: r.business_id,
    locationId: r.location_id ?? undefined,
    channel: r.channel,
    channelAccountId: r.channel_account_id ?? undefined,
    customerId: r.customer_id,
    status: r.status,
    handoffReason: r.handoff_reason ?? undefined,
    handoffSummary: r.handoff_summary ?? undefined,
    handoffAt: r.handoff_at?.toISOString(),
    handoffUserId: r.handoff_user_id ?? undefined,
    state: r.state ?? {},
    language: r.language ?? undefined,
    bookingId: r.booking_id ?? undefined,
    callId: r.call_id ?? undefined,
    lastMessageAt: r.last_message_at.toISOString(),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    closedAt: r.closed_at?.toISOString(),
  };
}

interface MessageRow {
  id: number;
  tenant_id: string;
  conversation_id: number;
  sender: Sender;
  direction: "in" | "out";
  content_type: ContentType;
  body: string | null;
  meta: Record<string, unknown>;
  provider_message_id: string | null;
  delivery_status: DeliveryStatus | null;
  error: string | null;
  created_at: Date;
}

function toMessage(r: MessageRow): Message {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    conversationId: r.conversation_id,
    sender: r.sender,
    direction: r.direction,
    contentType: r.content_type,
    body: r.body ?? undefined,
    meta: r.meta ?? {},
    providerMessageId: r.provider_message_id ?? undefined,
    deliveryStatus: r.delivery_status ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at.toISOString(),
  };
}

interface AccountRow {
  id: number;
  tenant_id: string;
  business_id: string;
  location_id: string | null;
  channel: Channel;
  provider: Provider;
  phone_e164: string | null;
  external_account_id: string | null;
  external_number_id: string | null;
  credentials_enc: string | null;
  status: "active" | "paused" | "revoked";
  ai_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Note what this drops: `credentials_enc`.
 *
 * The domain object has no credentials field at all, so no route, no page and
 * no log can serialise one by accident. The one function that needs the
 * plaintext asks for it by name — see `accountCredentials`.
 */
function toAccount(r: AccountRow): ChannelAccount {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    businessId: r.business_id,
    locationId: r.location_id ?? undefined,
    channel: r.channel,
    provider: r.provider,
    phoneE164: r.phone_e164 ?? undefined,
    externalAccountId: r.external_account_id ?? undefined,
    externalNumberId: r.external_number_id ?? undefined,
    status: r.status,
    aiEnabled: r.ai_enabled,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export async function findCustomer(
  tenantId: string,
  phoneE164: string,
): Promise<Customer | undefined> {
  const row = await one<CustomerRow>(
    "select * from customer where tenant_id = $1 and phone_e164 = $2",
    [tenantId, phoneE164],
  );
  return row && toCustomer(row);
}

export async function getCustomer(
  tenantId: string,
  id: number,
): Promise<Customer | undefined> {
  const row = await one<CustomerRow>(
    "select * from customer where tenant_id = $1 and id = $2",
    [tenantId, id],
  );
  return row && toCustomer(row);
}

/**
 * The person who just messaged, creating them if this is the first time.
 *
 * Upsert rather than select-then-insert: two messages arriving in the same
 * second from a number nobody has seen before would otherwise race and one
 * would fail on the unique index. The `on conflict` makes that case boring.
 */
export async function upsertCustomer(
  tenantId: string,
  phoneE164: string,
  fields: Partial<Pick<Customer, "firstName" | "lastName" | "email" | "language">> = {},
): Promise<Customer> {
  const row = await one<CustomerRow>(
    `insert into customer (tenant_id, phone_e164, first_name, last_name, email, language)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (tenant_id, phone_e164) do update set
       -- Only ever fill a blank. A name typed by staff must not be overwritten
       -- by a WhatsApp profile name, and a language detected once should not
       -- flip on a single "ok".
       first_name = coalesce(customer.first_name, excluded.first_name),
       last_name  = coalesce(customer.last_name,  excluded.last_name),
       email      = coalesce(customer.email,      excluded.email),
       language   = coalesce(customer.language,   excluded.language),
       updated_at = now()
     returning *`,
    [
      tenantId,
      phoneE164,
      fields.firstName ?? null,
      fields.lastName ?? null,
      fields.email ?? null,
      fields.language ?? null,
    ],
  );
  return toCustomer(row!);
}

// ---------------------------------------------------------------------------
// Channel accounts
// ---------------------------------------------------------------------------

/**
 * Which business owns the number this message was sent to.
 *
 * Deliberately *not* tenant-scoped, and the only function here that is not.
 * An inbound webhook has no session and no tenant — the number it arrived on
 * is what establishes one, and everything downstream is scoped by the tenant
 * this returns. Narrow, and commented so it stays narrow.
 */
export async function accountForInbound(
  channel: Channel,
  match: { phoneE164?: string; externalNumberId?: string },
): Promise<ChannelAccount | undefined> {
  const row = await one<AccountRow>(
    `select * from channel_account
      where channel = $1
        and status = 'active'
        and (($2::text is not null and phone_e164 = $2)
          or ($3::text is not null and external_number_id = $3))
      limit 1`,
    [channel, match.phoneE164 ?? null, match.externalNumberId ?? null],
  );
  return row && toAccount(row);
}

/**
 * Pause or revoke a number, or bring it back.
 *
 * A row is never deleted: the conversations that arrived through it point at
 * it, and a venue that leaves and returns should get its history back.
 * `accountForInbound` only matches active rows, so a paused number simply
 * stops receiving.
 */
export async function setAccountStatus(
  tenantId: string,
  id: number,
  status: ChannelAccount["status"],
): Promise<ChannelAccount | undefined> {
  const row = await one<AccountRow>(
    `update channel_account set status = $3, updated_at = now()
      where tenant_id = $1 and id = $2 returning *`,
    [tenantId, id, status],
  );
  return row && toAccount(row);
}

export async function listAccounts(tenantId: string): Promise<ChannelAccount[]> {
  const rows = await query<AccountRow>(
    "select * from channel_account where tenant_id = $1 order by id",
    [tenantId],
  );
  return rows.map(toAccount);
}

export async function getAccount(
  tenantId: string,
  id: number,
): Promise<ChannelAccount | undefined> {
  const row = await one<AccountRow>(
    "select * from channel_account where tenant_id = $1 and id = $2",
    [tenantId, id],
  );
  return row && toAccount(row);
}

/**
 * The sealed credential blob, by itself.
 *
 * Separate from `getAccount` on purpose: the only caller is the adapter about
 * to send a message. Everything else — routes, pages, the inbox, logs — gets
 * a `ChannelAccount` that has no credentials field to leak.
 */
export async function accountCredentials(
  tenantId: string,
  id: number,
): Promise<string | undefined> {
  const row = await one<{ credentials_enc: string | null }>(
    "select credentials_enc from channel_account where tenant_id = $1 and id = $2",
    [tenantId, id],
  );
  return row?.credentials_enc ?? undefined;
}

export async function saveAccount(input: {
  tenantId: string;
  businessId: string;
  locationId?: string;
  channel: Channel;
  provider: Provider;
  phoneE164?: string;
  externalAccountId?: string;
  externalNumberId?: string;
  /** Already sealed. This layer never sees plaintext. */
  credentialsEnc?: string;
  aiEnabled?: boolean;
}): Promise<ChannelAccount> {
  const row = await one<AccountRow>(
    `insert into channel_account
       (tenant_id, business_id, location_id, channel, provider, phone_e164,
        external_account_id, external_number_id, credentials_enc, ai_enabled)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10, true))
     on conflict (channel, phone_e164) where phone_e164 is not null
     do update set
       business_id         = excluded.business_id,
       location_id         = excluded.location_id,
       provider            = excluded.provider,
       external_account_id = excluded.external_account_id,
       external_number_id  = excluded.external_number_id,
       credentials_enc     = coalesce(excluded.credentials_enc, channel_account.credentials_enc),
       ai_enabled          = excluded.ai_enabled,
       status              = 'active',
       updated_at          = now()
     -- A number already claimed by a different tenant is not ours to take.
     where channel_account.tenant_id = excluded.tenant_id
     returning *`,
    [
      input.tenantId,
      input.businessId,
      input.locationId ?? null,
      input.channel,
      input.provider,
      input.phoneE164 ?? null,
      input.externalAccountId ?? null,
      input.externalNumberId ?? null,
      input.credentialsEnc ?? null,
      input.aiEnabled ?? null,
    ],
  );
  if (!row) {
    throw new Error(
      `That ${input.channel} number is already connected to another Belline account.`,
    );
  }
  return toAccount(row);
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function getConversation(
  tenantId: string,
  id: number,
): Promise<Conversation | undefined> {
  const row = await one<ConversationRow>(
    "select * from conversation where tenant_id = $1 and id = $2",
    [tenantId, id],
  );
  return row && toConversation(row);
}

/**
 * The thread this message belongs to.
 *
 * An open conversation is reused; a closed one is never reopened. That is a
 * product decision as much as a data one — "can you move tomorrow's
 * appointment" three weeks after a booking is a new conversation, and dragging
 * the old one back would hand the model a stale state to reason from.
 */
export async function openConversationFor(
  tenantId: string,
  customerId: number,
  channel: Channel,
): Promise<Conversation | undefined> {
  const row = await one<ConversationRow>(
    `select * from conversation
      where tenant_id = $1 and customer_id = $2 and channel = $3 and status <> 'CLOSED'
      order by last_message_at desc
      limit 1`,
    [tenantId, customerId, channel],
  );
  return row && toConversation(row);
}

export async function createConversation(input: {
  tenantId: string;
  businessId: string;
  locationId?: string;
  channel: Channel;
  channelAccountId?: number;
  customerId: number;
  language?: string;
}): Promise<Conversation> {
  const row = await one<ConversationRow>(
    `insert into conversation
       (tenant_id, business_id, location_id, channel, channel_account_id, customer_id, language)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning *`,
    [
      input.tenantId,
      input.businessId,
      input.locationId ?? null,
      input.channel,
      input.channelAccountId ?? null,
      input.customerId,
      input.language ?? null,
    ],
  );
  return toConversation(row!);
}

/**
 * Merge into the structured state.
 *
 * `jsonb ||` at the database rather than read-modify-write in Node, because
 * two messages from the same person can be in flight at once and a lost update
 * here means a forgotten service or a forgotten date.
 */
export async function patchState(
  tenantId: string,
  id: number,
  patch: Partial<ConversationState>,
): Promise<Conversation | undefined> {
  const row = await one<ConversationRow>(
    `update conversation
        set state = state || $3::jsonb, updated_at = now()
      where tenant_id = $1 and id = $2
      returning *`,
    [tenantId, id, JSON.stringify(patch)],
  );
  return row && toConversation(row);
}

export interface InboxFilter {
  status?: ConversationStatus[];
  /** Venues this user may see. Empty array means none; undefined means all in the tenant. */
  locationIds?: string[];
  limit?: number;
}

export async function listConversations(
  tenantId: string,
  filter: InboxFilter = {},
): Promise<Conversation[]> {
  const rows = await query<ConversationRow>(
    `select * from conversation
      where tenant_id = $1
        and ($2::text[] is null or status = any($2))
        -- A conversation with no branch chosen yet belongs to everyone who can
        -- see the business, or nobody would ever pick it up.
        and ($3::text[] is null or location_id is null or location_id = any($3))
      order by last_message_at desc
      limit $4`,
    [tenantId, filter.status ?? null, filter.locationIds ?? null, filter.limit ?? 100],
  );
  return rows.map(toConversation);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function listMessages(
  tenantId: string,
  conversationId: number,
  limit = 200,
): Promise<Message[]> {
  const rows = await query<MessageRow>(
    `select * from message
      where tenant_id = $1 and conversation_id = $2
      order by created_at asc, id asc
      limit $3`,
    [tenantId, conversationId, limit],
  );
  return rows.map(toMessage);
}

/**
 * Record a message, unless we have already seen it.
 *
 * Returns `{ duplicate: true }` when the provider id is one we hold, which is
 * the whole duplicate-webhook defence and the reason it lives in the database
 * rather than in a cache: Meta retries anything slow, retries can arrive at a
 * different process, and a retry handled twice is a duplicate booking.
 *
 * The insert races rather than checking first, because checking first is the
 * same race with extra steps.
 */
export async function recordMessage(input: {
  tenantId: string;
  conversationId: number;
  sender: Sender;
  direction: "in" | "out";
  contentType?: ContentType;
  body?: string;
  meta?: Record<string, unknown>;
  providerMessageId?: string;
  deliveryStatus?: DeliveryStatus;
  error?: string;
}): Promise<{ message: Message; duplicate: false } | { message: Message; duplicate: true }> {
  try {
    const row = await one<MessageRow>(
      `insert into message
         (tenant_id, conversation_id, sender, direction, content_type, body, meta,
          provider_message_id, delivery_status, error)
       values ($1,$2,$3,$4,coalesce($5,'text'),$6,coalesce($7,'{}'::jsonb),$8,$9,$10)
       returning *`,
      [
        input.tenantId,
        input.conversationId,
        input.sender,
        input.direction,
        input.contentType ?? null,
        input.body ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
        input.providerMessageId ?? null,
        input.deliveryStatus ?? null,
        input.error ?? null,
      ],
    );
    // Inbound messages move the thread up the inbox; a status receipt arriving
    // later must not.
    if (input.direction === "in" || input.sender !== "system") {
      await query(
        "update conversation set last_message_at = now(), updated_at = now() where tenant_id = $1 and id = $2",
        [input.tenantId, input.conversationId],
      );
    }
    return { message: toMessage(row!), duplicate: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await one<MessageRow>(
      `select * from message
        where tenant_id = $1 and conversation_id = $2 and provider_message_id = $3`,
      [input.tenantId, input.conversationId, input.providerMessageId ?? null],
    );
    if (!existing) throw err;
    return { message: toMessage(existing), duplicate: true };
  }
}

/** Attach the provider's id to a message we sent, once the send returns. */
export async function markSent(
  tenantId: string,
  messageId: number,
  providerMessageId: string,
): Promise<void> {
  await query(
    `update message set provider_message_id = $3, delivery_status = 'sent'
      where tenant_id = $1 and id = $2`,
    [tenantId, messageId, providerMessageId],
  );
}

export async function markDelivery(
  tenantId: string,
  providerMessageId: string,
  status: DeliveryStatus,
  error?: string,
): Promise<void> {
  await query(
    `update message set delivery_status = $3, error = coalesce($4, error)
      where tenant_id = $1 and provider_message_id = $2`,
    [tenantId, providerMessageId, status, error ?? null],
  );
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/**
 * Move a conversation, and refuse the moves that make no sense.
 *
 * `expect` is the important argument. Taking over is only valid from the state
 * the person saw when they clicked, and returning to Belline is only valid
 * from HUMAN_ACTIVE — without that, two members of staff clicking "take over"
 * at the same moment both succeed and each believes they own it.
 *
 * Returns undefined when the conversation was not in `expect`, which the
 * caller should report as "somebody got there first" rather than retry.
 */
export async function transition(
  tenantId: string,
  id: number,
  to: ConversationStatus,
  opts: {
    expect?: ConversationStatus[];
    reason?: string;
    summary?: string;
    userId?: string;
  } = {},
): Promise<Conversation | undefined> {
  const row = await one<ConversationRow>(
    `update conversation set
       status          = $3,
       handoff_reason  = case when $3 = 'HANDOFF_REQUESTED' then coalesce($5, handoff_reason) else handoff_reason end,
       handoff_summary = case when $3 = 'HANDOFF_REQUESTED' then coalesce($6, handoff_summary) else handoff_summary end,
       handoff_at      = case when $3 = 'HANDOFF_REQUESTED' then now() else handoff_at end,
       handoff_user_id = case when $3 = 'HUMAN_ACTIVE' then coalesce($7, handoff_user_id) else handoff_user_id end,
       closed_at       = case when $3 = 'CLOSED' then now() else null end,
       updated_at      = now()
     where tenant_id = $1
       and id = $2
       and ($4::text[] is null or status = any($4))
     returning *`,
    [
      tenantId,
      id,
      to,
      opts.expect ?? null,
      opts.reason ?? null,
      opts.summary ?? null,
      opts.userId ?? null,
    ],
  );
  return row && toConversation(row);
}

/**
 * The model's own history of this conversation.
 *
 * Opaque on purpose — it holds tool calls, tool results and thinking blocks,
 * and the API rejects a history that has been tidied. Nothing above this layer
 * should be tempted to read or edit it; the *legible* record of what was said
 * is the `message` rows.
 */
export async function agentHistory(
  tenantId: string,
  conversationId: number,
): Promise<unknown[]> {
  const row = await one<{ agent_history: unknown[] }>(
    "select agent_history from conversation where tenant_id = $1 and id = $2",
    [tenantId, conversationId],
  );
  return row?.agent_history ?? [];
}

export interface TurnCommit {
  /** What Belline decided to say. Empty means it said nothing, which is valid. */
  reply?: string;
  history: unknown[];
  statePatch?: Partial<ConversationState>;
  /** The venue's own episode record, created on the first turn. */
  callId?: string;
  bookingId?: string;
  /** Set when the turn ended in a handoff rather than a reply. */
  handoff?: { reason: string; summary: string };
}

/**
 * Commit a turn, but only if Belline is still allowed to speak.
 *
 * The lock is taken *after* the model has produced its answer, not around it.
 * Holding a Postgres transaction open across a multi-second model call would
 * pin a connection for the whole of it; the race that actually matters is
 * narrower than that — it is whether a person took the conversation over while
 * Belline was thinking, and that is decided here, in one statement, before the
 * reply is written.
 *
 * Returns undefined when they did. The caller throws the generated reply away
 * and sends nothing, which costs a few hundred tokens and is the correct price
 * for never talking over a member of staff.
 *
 * The outbound message is written as `queued` and committed *before* it is
 * sent. Sending is an external side effect that cannot be rolled back, so the
 * row has to exist first: a message that went out and was never recorded is
 * invisible to the inbox, and a member of staff would answer a question
 * Belline had already answered.
 */
export async function commitAiTurn(
  tenantId: string,
  conversationId: number,
  turn: TurnCommit,
): Promise<{ conversation: Conversation; messageId?: number } | undefined> {
  return tx(async (client) => {
    const { rows } = await client.query<ConversationRow>(
      "select * from conversation where tenant_id = $1 and id = $2 for update",
      [tenantId, conversationId],
    );
    const current = rows[0];
    if (!current || current.status !== "AI_ACTIVE") return undefined;

    let messageId: number | undefined;
    if (turn.reply?.trim()) {
      const { rows: inserted } = await client.query<{ id: number }>(
        `insert into message
           (tenant_id, conversation_id, sender, direction, content_type, body, delivery_status)
         values ($1,$2,'ai','out','text',$3,'queued')
         returning id`,
        [tenantId, conversationId, turn.reply.trim()],
      );
      messageId = inserted[0]?.id;
    }

    const { rows: updated } = await client.query<ConversationRow>(
      `update conversation set
         agent_history   = $3::jsonb,
         state           = state || $4::jsonb,
         call_id         = coalesce($5, call_id),
         booking_id      = coalesce($6, booking_id),
         status          = case when $7::text is not null then 'HANDOFF_REQUESTED' else status end,
         handoff_reason  = coalesce($7, handoff_reason),
         handoff_summary = coalesce($8, handoff_summary),
         handoff_at      = case when $7::text is not null then now() else handoff_at end,
         last_message_at = now(),
         updated_at      = now()
       where tenant_id = $1 and id = $2
       returning *`,
      [
        tenantId,
        conversationId,
        JSON.stringify(turn.history),
        JSON.stringify(turn.statePatch ?? {}),
        turn.callId ?? null,
        turn.bookingId ?? null,
        turn.handoff?.reason ?? null,
        turn.handoff?.summary ?? null,
      ],
    );

    return { conversation: toConversation(updated[0]), messageId };
  });
}

/**
 * Run something with the conversation locked, and only if Belline may speak.
 *
 * This is the guarantee the whole handoff design rests on. Checking the status
 * and *then* generating a reply is not enough: generation takes seconds, and
 * staff take over during them — so the check has to be held until the outbound
 * message is written, which means a row lock and one transaction.
 *
 * Returns undefined when a person has taken the conversation, and the caller
 * throws its generated reply away. Losing a few hundred tokens is the correct
 * price for never talking over a member of staff.
 */
export async function withAiTurn<T>(
  tenantId: string,
  conversationId: number,
  fn: (c: pg.PoolClient, conversation: Conversation) => Promise<T>,
): Promise<T | undefined> {
  return tx(async (client) => {
    const { rows } = await client.query<ConversationRow>(
      `select * from conversation
        where tenant_id = $1 and id = $2
        for update`,
      [tenantId, conversationId],
    );
    const row = rows[0];
    if (!row || row.status !== "AI_ACTIVE") return undefined;
    return fn(client, toConversation(row));
  });
}
