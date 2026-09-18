import { closedConnector } from "./closed";
import { PARTNERS } from "./registry";

/**
 * Vagaro. The documentation is real, readable, and does not contain a booking API.
 *
 * This is the most interesting refusal on the list, because it is the only one
 * where the research had to say no to something it could actually read.
 * `docs.vagaro.com` is Vagaro's own developer site and it opens. Nobody has to
 * be provisioned an account, as with Booksy; nobody has to sign anything first,
 * as with Treatwell. The reason there is no adapter here is simply that what is
 * documented cannot take a booking.
 *
 * Vagaro's own API introduction names five capability areas — Employee
 * Management, Locations, Appointments, Customers, Employees — and describes
 * them in read terms: an appointment can be *retrieved*, with its status, start
 * time and who is providing the service. There is no availability search
 * anywhere, and no documented endpoint to create, move or cancel an
 * appointment. The pages that would carry the reference itself
 * (`/public/reference/getting-started`, `/public/reference/authentication`) are
 * unfilled template stubs, concrete reference slugs answer 404, and no base URL
 * is published at all. `developers.vagaro.com` and `sandbox.vagaro.com` do not
 * resolve.
 *
 * What *is* properly documented is the webhook side, and it is good: Appointment,
 * Customer, FormResponse, Transaction, business location and Employee events,
 * an envelope of id, createdDate, type, action and payload, HTTPS POST with a
 * 2xx inside twenty seconds, five retries over fifteen minutes with exponential
 * backoff. That is a real integration surface — for knowing what has already
 * happened. A receptionist needs to know what is free on Tuesday, and no amount
 * of webhook quality answers that.
 *
 * So Belline is not written against it. A "Vagaro integration" built on what is
 * published would be a sync, and calling it a booking integration would be the
 * kind of thing this directory exists to prevent.
 *
 * **The commercial gate is the part to know before spending a call.** Access
 * goes through Vagaro's Enterprise Sales team, and their support material
 * conditions it on the merchant being a paid, non-trial account *actively using
 * Vagaro's own credit card processing*. That is not a hurdle Belline can clear
 * once; it is a requirement on every single salon Belline would want to connect,
 * and it will disqualify some of them outright.
 *
 * **One thing not to confuse.** The "Vagaro Marketplace" is the consumer-facing
 * directory where clients find businesses. It is not a developer app store, and
 * several third-party write-ups treat it as one. There is nothing to publish an
 * app into.
 *
 * **What the founder would have to do:** contact Enterprise Sales through the
 * form linked from Vagaro's APIs and Webhooks page, and ask the one question
 * that decides everything — whether any unpublished endpoint can read
 * availability and write an appointment. If the answer is no, Vagaro is a
 * reporting integration and should be dropped from the booking roadmap rather
 * than carried on it.
 */
export const vagaroConnector = closedConnector(PARTNERS.vagaro);
