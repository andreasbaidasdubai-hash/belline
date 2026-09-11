import type { DateStr, Minutes, Slot } from "../types";

/**
 * Reception: the channel-neutral half of Belline.
 *
 * Nothing in this file says WhatsApp. A conversation is a thread with one
 * person on one channel, and the channel is a string — because the argument
 * this whole feature rests on is that WhatsApp is a second mouth on the same
 * head, not a second product. When web chat arrives it adds a value to a
 * union and an adapter, and nothing here changes.
 */

export type Channel = "whatsapp" | "sms" | "webchat";

export type Provider = "meta" | "twilio" | "internal";

/**
 * Where a conversation is, and therefore who is allowed to answer it.
 *
 * The states are few on purpose. Every extra one is another combination to
 * reason about at the moment a customer is waiting, and the only distinction
 * that genuinely changes behaviour is whether Belline may speak.
 */
export type ConversationStatus =
  /** Belline answers. The normal state. */
  | "AI_ACTIVE"
  /** A person has been asked for; Belline has said so and stopped. */
  | "HANDOFF_REQUESTED"
  /** A person is answering. Belline must not. */
  | "HUMAN_ACTIVE"
  /** Finished. A new message starts a new conversation. */
  | "CLOSED";

/** Belline may generate a reply in exactly one of these. */
export function aiMaySpeak(status: ConversationStatus): boolean {
  return status === "AI_ACTIVE";
}

export type Sender = "customer" | "ai" | "human" | "system";

export type ContentType =
  | "text"
  | "audio"
  | "image"
  | "document"
  | "location"
  | "unsupported";

export type DeliveryStatus = "queued" | "sent" | "delivered" | "read" | "failed";

export interface Customer {
  id: number;
  tenantId: string;
  /** E.164, always. A number stored twice in two formats is two customers. */
  phoneE164: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  /** BCP-47, detected from what they wrote. */
  language?: string;
  /** Staff-written. Never shown to the customer, never given to the model. */
  notes?: string;
  preferences: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelAccount {
  id: number;
  tenantId: string;
  businessId: string;
  /** The venue this number books into. Unset when one number serves several. */
  locationId?: string;
  channel: Channel;
  provider: Provider;
  phoneE164?: string;
  externalAccountId?: string;
  externalNumberId?: string;
  status: "active" | "paused" | "revoked";
  /** False means every message waits for a person. The inbox without the agent. */
  aiEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the conversation is about, structured.
 *
 * This is the answer to "the later one". Replaying a whole transcript on every
 * message and hoping the model re-derives the same slot is both expensive and
 * unreliable; resolving an ordinal against `availabilityResults` is neither.
 *
 * Every field is optional because a conversation acquires them in whatever
 * order the customer happens to mention them, which is the entire difference
 * between a receptionist and a form.
 */
export interface ConversationState {
  intent?: "book" | "change" | "cancel" | "ask" | "complain" | "other";
  serviceIds?: string[];
  /** What they called it, before it was matched to a service id. */
  serviceText?: string;
  date?: DateStr;
  /** A specific time, once they have named one. */
  timeMin?: Minutes;
  /** "after six", "around four", "tomorrow afternoon". */
  window?: { earliestMin: Minutes; latestMin: Minutes };
  staffId?: string;
  staffText?: string;
  locationId?: string;
  partySize?: number;
  /** The last thing check_availability returned, in the order it was read out. */
  availabilityResults?: Slot[];
  /** Set once they have chosen. Nothing books without it. */
  selectedSlot?: Slot;
  customerName?: string;
  bookingRef?: string;
  /** How many turns in a row Belline failed to make progress. Feeds escalation. */
  confusionStreak?: number;
}

export interface Conversation {
  id: number;
  tenantId: string;
  businessId: string;
  locationId?: string;
  channel: Channel;
  channelAccountId?: number;
  customerId: number;
  status: ConversationStatus;
  handoffReason?: string;
  handoffSummary?: string;
  handoffAt?: string;
  handoffUserId?: string;
  state: ConversationState;
  language?: string;
  bookingId?: string;
  /**
   * The venue's own episode record.
   *
   * A WhatsApp conversation produces a Call like a telephone one does, because
   * "what did Belline do for me this week" must not have two answers depending
   * on the channel. This is the link; the call itself lives in the JSON book
   * with every other call.
   */
  callId?: string;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface Message {
  id: number;
  tenantId: string;
  conversationId: number;
  sender: Sender;
  direction: "in" | "out";
  contentType: ContentType;
  body?: string;
  meta: Record<string, unknown>;
  providerMessageId?: string;
  deliveryStatus?: DeliveryStatus;
  error?: string;
  createdAt: string;
}

/**
 * A message as it arrives, before anything has been decided about it.
 *
 * Normalised by the adapter, so nothing downstream ever sees a provider's
 * envelope. `raw` is kept for debugging and is never parsed a second time —
 * re-reading a provider payload in two places is how two code paths end up
 * disagreeing about what a customer said.
 */
export interface InboundMessage {
  channel: Channel;
  provider: Provider;
  /** The dedup key. Absent means the provider gave us none, which is a bug in the adapter. */
  providerMessageId: string;
  /** The business number it was sent to — how we find the account. */
  toE164?: string;
  externalNumberId?: string;
  fromE164: string;
  /** What the sender's profile says they are called, if the provider offers it. */
  profileName?: string;
  content:
    | { type: "text"; text: string }
    | { type: "audio"; mediaId: string; mime?: string }
    | { type: "unsupported"; kind: string };
  timestamp: string;
  raw: unknown;
}

/** A delivery receipt, normalised the same way. */
export interface StatusUpdate {
  providerMessageId: string;
  status: DeliveryStatus;
  error?: string;
  timestamp: string;
}
