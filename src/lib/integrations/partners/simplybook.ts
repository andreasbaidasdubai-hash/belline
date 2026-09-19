import { openCredentials } from "../../db/credentials";
import {
  PartnerNotConnected,
  PartnerUnsupported,
  partnerLinkOf,
  partnerMode,
  type PartnerApi,
  type PartnerAvailabilityQuery,
  type PartnerBookingRef,
  type PartnerConnector,
  type PartnerCreate,
  type PartnerSlot,
  type PartnerVenue,
} from "./contract";
import { httpTransport, type PartnerRequest, type PartnerTransport } from "./http";
import { PARTNERS } from "./registry";
import { sandboxPartner } from "./sandbox";

/**
 * SimplyBook.me, through its REST v2 admin API.
 *
 * The second partner on the whole list a business can connect without anyone's
 * permission, and the first one whose price is honest for a small Gulf salon:
 * the API is an ordinary custom feature rather than a top-tier upsell
 * (registry.ts has the plan table). All four operations are documented, so this
 * joins Microsoft Bookings and Cal.com as an adapter that could work the day a
 * venue hands over a key.
 *
 *   POST   /admin/auth                       company + login + API user key
 *   POST   /admin/auth/refresh-token
 *   GET    /admin/schedule/available-slots   what the company will actually take
 *   GET    /admin/services                   the duration, so none is invented
 *   POST   /admin/bookings
 *   PUT    /admin/bookings/{id}
 *   DELETE /admin/bookings/{id}
 *
 * ## Which API this is, and why not the other one
 *
 * SimplyBook has two live APIs. The legacy JSON-RPC one at
 * `user-api.simplybook.me` is the one every third-party guide describes, and it
 * is the worse choice: its public service has no reschedule at all, and its
 * cancellation needs an `md5(bookingId . bookingHash . secretKey)` signature
 * computed from a hash returned by the original booking. REST v2 has a plain
 * `PUT` and a plain `DELETE`, and SimplyBook publishes an OpenAPI document for
 * it. Nothing here should be "modernised" back onto JSON-RPC.
 *
 * ## The three things that decide whether a venue is connected
 *
 * **The host.** SimplyBook runs thirteen regional and white-label hosts and a
 * company lives on exactly one. The wrong host does not error usefully — it
 * answers that the company does not exist. So the host is recorded on the
 * venue, and a venue without one is not connected rather than tried against a
 * default that would be wrong for most of the world.
 *
 * **The credential.** `POST /admin/auth` will take a user's real password, and
 * Belline will not. The API User Key a business generates under Settings → API
 * User Keys is the credential designed for exactly this, it can be revoked on
 * its own, and it does not break when somebody changes their password.
 *
 * **Two-factor authentication.** When the API user has 2FA on, the auth call
 * succeeds and hands back `require2fa` with empty tokens. There is no
 * unattended way past it, so that is read as "not connected" and said plainly,
 * rather than retried until the venue looks broken.
 */

const facts = PARTNERS.simplybook;

/** The global default. Twelve more exist, and the venue's own is what is used. */
export const SIMPLYBOOK_DEFAULT_HOST = "https://user-api-v2.simplybook.me/";

/**
 * An API User Key is prefixed, and a password is not.
 *
 * The check for it is not decoration: `POST /admin/auth` accepts both, so
 * pasting an owner's password into the setup field would *work*, and would
 * leave Belline holding a salon owner's login. Refusing the shape is the only
 * moment anyone would notice.
 */
export const SIMPLYBOOK_KEY_PREFIX = "api_user_key_";

export function looksLikeApiUserKey(value: string): boolean {
  return value.trim().startsWith(SIMPLYBOOK_KEY_PREFIX);
}

// ---------------------------------------------------------------------------
// The shapes, only the fields Belline reads
// ---------------------------------------------------------------------------

interface TokenEntity {
  token?: string;
  refresh_token?: string;
  /** Set when the account has 2FA on, in which case the tokens are empty. */
  require2fa?: boolean;
}

/** `{ id, date: "2026-09-21", time: "09:00:00" }` */
interface TimeSlotEntity {
  id?: string;
  date?: string;
  time?: string;
}

interface ServiceEntity {
  id?: string | number;
  name?: string;
  /** Minutes, as SimplyBook's own service record holds it. */
  duration?: number | string;
}

interface BookingResultEntity {
  id?: string | number;
  code?: string;
  bookings?: { id?: string | number; code?: string }[];
}

/** "09:00:00" → 540. Anything else is not a time, and yields NaN rather than a guess. */
export function minutesOf(value: string | undefined): number {
  const m = /^(\d{2}):(\d{2})/.exec((value ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** 540 → "09:00:00", the shape SimplyBook's datetimes carry. */
const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:00`;

/** "2026-09-21" + 540 → "2026-09-21 09:00:00". A wall time at the company, never an instant. */
export function stamp(date: string, min: number): string {
  return `${date} ${clock(min)}`;
}

/**
 * The service's own length in minutes, or undefined.
 *
 * SimplyBook reports duration as a number of minutes, but the OpenAPI document
 * types it loosely enough that a string arrives in practice. Anything that is
 * not a positive finite number of minutes is undefined — and a service whose
 * length cannot be read is one Belline does not quote, exactly as with
 * Microsoft Bookings.
 */
export function durationOf(service: ServiceEntity | undefined): number | undefined {
  const raw = typeof service?.duration === "string" ? Number(service.duration.trim()) : service?.duration;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export function simplybookApi(transport: PartnerTransport): PartnerApi {
  /** The company's own services, read fresh: the duration is theirs, never ours. */
  async function serviceOf(serviceId: string): Promise<ServiceEntity | undefined> {
    const services = await transport.request<ServiceEntity[] | { data?: ServiceEntity[] }>({
      method: "GET",
      path: "admin/services",
    });
    const all = Array.isArray(services) ? services : (services.data ?? []);
    return all.find((s) => String(s.id) === serviceId);
  }

  return {
    async availability(query: PartnerAvailabilityQuery): Promise<PartnerSlot[]> {
      // SimplyBook computes availability for a service given by a provider.
      // Without both it has no question to answer, and Belline does not answer
      // it on the company's behalf.
      const serviceId = query.serviceIds?.[0];
      const providerId = query.staffId;
      if (!serviceId || !providerId) return [];

      // The slots endpoint returns starts only. The length comes off the
      // company's own service record on every call, and a service whose
      // duration cannot be read yields no times rather than a Belline default.
      const service = await serviceOf(serviceId);
      const durationMin = durationOf(service);
      if (durationMin === undefined) return [];

      const answer = await transport.request<TimeSlotEntity[] | { data?: TimeSlotEntity[] }>({
        method: "GET",
        path: "admin/schedule/available-slots",
        query: { service_id: serviceId, provider_id: providerId, date: query.date, count: 1 },
      });
      const slots = Array.isArray(answer) ? answer : (answer.data ?? []);

      return slots
        .map((slot): PartnerSlot => {
          const startMin = minutesOf(slot.time);
          return {
            date: slot.date ?? query.date,
            startMin,
            endMin: startMin + durationMin,
            // The provider was named in the question, so naming them in the
            // answer is reporting rather than promising.
            staffId: providerId,
            token: slot.id ? String(slot.id) : undefined,
          };
        })
        // A slot filed under another day is not an answer to this day's
        // question, and an unreadable time is not a slot.
        .filter((s) => s.date === query.date && Number.isFinite(s.startMin))
        .filter((s) => (query.fromMin === undefined || s.startMin >= query.fromMin) && (query.toMin === undefined || s.startMin <= query.toMin))
        .sort((a, b) => a.startMin - b.startMin);
    },

    async create(input: PartnerCreate): Promise<PartnerBookingRef> {
      const serviceId = input.serviceIds?.[0];
      if (!serviceId) throw new PartnerUnsupported("simplybook", "SimplyBook.me needs the service before it can take a booking");
      if (!input.staffId) throw new PartnerUnsupported("simplybook", "SimplyBook.me needs the provider before it can take a booking");
      const made = await transport.request<BookingResultEntity>({
        method: "POST",
        path: "admin/bookings",
        body: {
          service_id: serviceId,
          provider_id: input.staffId,
          // Wall times at the company. SimplyBook resolves them against the
          // company's own zone, so Belline never converts to an instant here —
          // which is the opposite of Cal.com and is worth not "tidying".
          start_datetime: stamp(input.date, input.startMin),
          end_datetime: stamp(input.date, input.endMin),
          count: 1,
          client: {
            name: input.guestName,
            phone: input.guestPhone,
            // SimplyBook does not require an address, unlike Cal.com. Where the
            // conversation has one it is passed so the guest gets a
            // confirmation; where it does not, the booking is still taken.
            email: input.guestEmail?.trim() || undefined,
          },
          comment: input.notes,
        },
      });
      const booking = made.bookings?.[0] ?? made;
      const id = booking.id === undefined ? undefined : String(booking.id);
      if (!id) throw new Error("SimplyBook.me did not return the booking it made");
      // The code is what a guest reads back to the salon; the id is what every
      // other endpoint takes.
      return { id, ref: booking.code ?? undefined };
    },

    async reschedule(ref, changes): Promise<PartnerBookingRef> {
      // One call, and the guest keeps one booking. Zenoti's cancel-then-rebook
      // recipe is what this is not.
      await transport.request<BookingResultEntity>({
        method: "PUT",
        path: `admin/bookings/${encodeURIComponent(ref.id)}`,
        body: {
          start_datetime: stamp(changes.date, changes.startMin),
          end_datetime: stamp(changes.date, changes.endMin),
          provider_id: changes.staffId,
        },
      });
      // The booking keeps its id and its code through a move.
      return { id: ref.id, ref: ref.ref };
    },

    async cancel(ref): Promise<void> {
      // REST v2 cancels by id alone. The legacy JSON-RPC API needed an md5 of
      // the booking hash and a secret key, which is the other reason this
      // adapter is not written against it.
      await transport.request<unknown>({
        method: "DELETE",
        path: `admin/bookings/${encodeURIComponent(ref.id)}`,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The company's own token
// ---------------------------------------------------------------------------

interface TokenCache {
  token: string;
  /** Not an expiry: SimplyBook does not publish the token's lifetime. */
  issuedAt: number;
}

/** One token per company, for as long as this process lives. */
const tokens = new Map<string, TokenCache>();

/**
 * A bearer token for one company, from its own API User Key.
 *
 * SimplyBook does not document how long a v2 token lasts — the legacy guide
 * says an hour and the v2 specification says nothing — so nothing here trusts a
 * number. The token is reused while it works and re-minted when a call comes
 * back unauthorised (see `authorisedTransport`), which is correct whatever the
 * real lifetime turns out to be.
 */
export async function simplybookToken(
  host: string,
  companyLogin: string,
  apiUserKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(new URL("admin/auth", host.endsWith("/") ? host : `${host}/`), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ company: companyLogin, login: companyLogin, password: apiUserKey }),
  });
  if (!res.ok) {
    // The commonest cause by far is the wrong regional host, which answers
    // that the company does not exist rather than that the host is wrong.
    throw new PartnerNotConnected(
      "simplybook",
      `${companyLogin} would not issue a token at ${host} — check the company's own regional host and that its API User Key is still valid`,
    );
  }
  const data = (await res.json()) as TokenEntity;
  if (data.require2fa) {
    // A person has to type a code. There is no unattended path past this, and
    // pretending otherwise would make the venue look intermittently broken.
    throw new PartnerNotConnected(
      "simplybook",
      `${companyLogin}'s API user has two-factor authentication on, which cannot be used unattended — the venue must issue an API User Key to a user without it`,
    );
  }
  if (!data.token) throw new PartnerNotConnected("simplybook", `${companyLogin} returned no token`);
  tokens.set(`${host}|${companyLogin}`, { token: data.token, issuedAt: Date.now() });
  return data.token;
}

/** Forget every cached token: a revoked key must not keep working. */
export function forgetSimplybookTokens(): void {
  tokens.clear();
}

/**
 * The transport, with the company's token on it and one retry on a 401.
 *
 * The retry exists because the token's lifetime is undocumented. Exactly one
 * is attempted, and only for an unauthorised answer: a partner that refuses
 * twice is a partner that is refusing, and the caller is told so rather than
 * kept waiting while Belline argues with it.
 */
export function authorisedTransport(
  host: string,
  companyLogin: string,
  apiUserKey: string,
  mint: typeof simplybookToken = simplybookToken,
): PartnerTransport {
  const cacheKey = `${host}|${companyLogin}`;
  return {
    async request<T>(req: PartnerRequest): Promise<T> {
      const send = async (token: string) =>
        httpTransport(facts, {
          baseUrl: host,
          auth: { "X-Company-Login": companyLogin, "X-Token": token },
        }).request<T>(req);

      let token = tokens.get(cacheKey)?.token ?? (await mint(host, companyLogin, apiUserKey));
      try {
        return await send(token);
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== 401) throw err;
        tokens.delete(cacheKey);
        token = await mint(host, companyLogin, apiUserKey);
        return await send(token);
      }
    },
  };
}

export const simplybookConnector: PartnerConnector = {
  facts,

  linked(location: PartnerVenue): boolean {
    return Boolean(partnerLinkOf(location, "simplybook")?.venueId);
  },

  usable(location: PartnerVenue, env = process.env): boolean {
    const mode = partnerMode(facts, env);
    if (mode === "off") return false;
    const link = partnerLinkOf(location, "simplybook");
    if (!link?.venueId || link.expiredAt || link.misconfiguredAt) return false;
    if (mode === "sandbox") return true;
    // Live needs the company's own API User Key and the regional host its
    // company actually lives on. A missing host is not a detail to default:
    // the global host would answer "company does not exist" for most of the
    // world, which reads as a broken venue rather than an unfinished setup.
    return Boolean(link.sealedToken) && Boolean(link.baseUrl?.trim());
  },

  apiFor(location: PartnerVenue, env = process.env): PartnerApi | null {
    if (!this.usable(location, env)) return null;
    const link = partnerLinkOf(location, "simplybook")!;
    if (partnerMode(facts, env) === "sandbox") {
      return sandboxPartner(facts, { opens: 9 * 60, closes: 17 * 60, stepMin: 30, staff: [{ id: "sb-provider-1", name: "Rana" }] });
    }
    const sealed = openCredentials(link.sealedToken!);
    const apiUserKey = sealed.apiKey;
    if (!apiUserKey) throw new PartnerNotConnected("simplybook", "this venue's SimplyBook.me company has not issued Belline an API User Key");
    // The key belongs to the company and is theirs to revoke; nothing about
    // SimplyBook is ever read from env.
    const host = link.baseUrl?.trim();
    if (!host) throw new PartnerNotConnected("simplybook", "this venue has not recorded which SimplyBook.me host its company lives on");
    const companyLogin = link.venueId!;
    return simplybookApi(authorisedTransport(host, companyLogin, apiUserKey));
  },

  refFields(ref: PartnerBookingRef) {
    return { partnerBookingId: ref.id, partnerRef: ref.ref };
  },
};
