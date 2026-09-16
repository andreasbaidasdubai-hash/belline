import Anthropic from "@anthropic-ai/sdk";
import type { ExceptionKind, Location, User, WeeklyHours } from "../types";
import { getLocation, listCalls, upsertLocation } from "../store";
import { publish } from "../brain";
import { isBlocking, validateVenue } from "../booking/config";
import { parseClock } from "../time";
import { flag } from "../flags";
import { raiseException } from "../errors/customer";
import { destinationOf, serviceLengthsRequired } from "../booking/destination";
import { PBX_NOTE, forwardingCodes, uaeCarriers } from "../telephony/forwarding";
import { bellineNumberOf } from "../telephony/number";
import { KIND_META, isExceptionKind, openException, ownerTickets } from "../exceptions";
import { DAYS, dayIndexes } from "./review";
import { readiness } from "./index";
import { factsFrom, journey, recordStep, type Journey, type StepId } from "./journey";
import { applyRules } from "./rules";
import { checkInstall } from "./platform";
import { HELP_ARTICLES, articleFor, articleForStep } from "./help";

/**
 * Setting a venue up by talking to Belle.
 *
 * The website reader drafts most of a venue; this is for everything it could
 * not read, everything the owner wants to change, and anywhere they are stuck.
 * The owner answers in their own words, and every answer becomes a small,
 * validated change:
 *
 *   Each tool builds the venue it would produce and runs the same gate the
 *   venue editor uses (`validateVenue`). A change that would leave the diary
 *   unable to take a booking is refused with the reason, which Belle says in
 *   plain words and asks again — never a crash, never a silent save.
 *
 *   Every accepted change to what the agent knows is published as a Business
 *   Brain version authored by the owner with the note "Set up with Belle", so
 *   it is on the history and one click from being reverted.
 *
 *   Only what the owner said is saved. The prompt says so, and the tools
 *   cannot invent anything the model did not pass them.
 *
 * Belle knows where the owner is (`journey()`), can explain forwarding and
 * check a website install, and reads the same help articles the setup pages
 * show. She hands over to a person only when nobody could finish it alone:
 * `open_exception` refuses any kind an owner can fix themselves, and refuses
 * "I want a person" until the owner has said it twice. With no model switched
 * on, the owner still gets the next step, its fix button and its article —
 * Belle is never the only way through a step.
 */

type By = Pick<User, "id" | "name">;

export interface SetupToolResult {
  ok: boolean;
  say: string;
  missing?: string[];
  /** Set when a ticket was opened for the Belline team. */
  ticket?: string;
}

export interface SetupMessage {
  role: "user" | "assistant";
  content: string;
}

/** What the model call returns, loosely: the real SDK and the fake model both fit. */
type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown };
export type SetupModel = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<{ content: Block[] }>;

const anthropicSetupModel: SetupModel = (params) => new Anthropic().messages.create(params) as Promise<{ content: Block[] }>;

// The same day words the setup review form reads (review.ts), so "weekdays"
// means one thing whether it is typed or said to Belle.

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "item";
}

/** Save a proposed venue if the gate allows it, and publish it as a version. */
function commit(before: Location, next: Location, by: By, what: string): SetupToolResult {
  const findings = validateVenue(next);
  if (isBlocking(findings)) {
    return {
      ok: false,
      say:
        "That was not saved, because the diary could not take bookings with it: " +
        findings.filter((f) => f.level === "error").map((f) => f.message).join(" ") +
        " Explain this plainly and ask for the corrected detail.",
    };
  }
  const saved = upsertLocation(next);
  publish(before.id, by, `Set up with Belle: ${what}`);
  // Warnings that this change introduced, so "is that right?" is asked now
  // rather than discovered on a call.
  const already = new Set(validateVenue(before).map((f) => f.message));
  const fresh = findings.filter((f) => f.level === "warning" && !already.has(f.message)).map((f) => f.message);
  return {
    ok: true,
    say: fresh.length
      ? `Saved: ${what}. But check this with them: ${fresh.join(" ")}`
      : `Saved: ${what}. Confirm it in one short sentence, then ask about the next missing thing.`,
    missing: readiness(saved).missing.map((m) => m.label),
  };
}

// --- asking for a person ----------------------------------------------------

const ASKS_FOR_PERSON =
  /\b(human|real person|actual person|a person|somebody real|someone real|(speak|talk|chat) (to|with) (someone|somebody|a person|the team|support|belline))\b/i;

/** How many times the owner has asked for a person in this conversation. */
export function humanAsks(history: SetupMessage[]): number {
  return history.filter((m) => m.role === "user" && ASKS_FOR_PERSON.test(m.content)).length;
}

function excerpt(history: SetupMessage[]): string {
  return history
    .slice(-8)
    .map((m) => `${m.role === "user" ? "Owner" : "Belle"}: ${m.content.slice(0, 240)}`)
    .join("\n");
}

const SELF_SERVE =
  "Not opened: this is something the owner can do themselves. Walk them through it with help_article or explain_forwarding, one step at a time. Do not mention tickets or the team.";

/**
 * May Belle open this ticket? Only for a kind no owner can fix alone, only
 * when the venue's state agrees, and a request for a person only once it has
 * been made twice.
 */
export function exceptionAllowed(
  kind: unknown,
  location: Location,
  history: SetupMessage[],
): { ok: true; kind: ExceptionKind } | { ok: false; say: string } {
  if (!isExceptionKind(kind) || !KIND_META[kind].belle) return { ok: false, say: SELF_SERVE };
  if (kind === "owner_requested_human" && humanAsks(history) < 2) {
    return {
      ok: false,
      say: "Not opened: they have asked for a person once. Help with what they are stuck on first, and say that if they still want a person they can ask again.",
    };
  }
  const belline = bellineNumberOf(location);
  const hasNumber = Boolean(belline);
  if ((kind === "pool_empty" || kind === "number_assign_failed") && hasNumber) {
    return { ok: false, say: `Not opened: this business already has its Belline number, ${belline}. Help them forward to it.` };
  }
  if (kind === "forwarding_unverified_2x" && !hasNumber) {
    return { ok: false, say: "Not opened: there is no Belline number to forward to yet. Its preparation is already known to the team." };
  }
  return { ok: true, kind };
}

// --- tools ------------------------------------------------------------------

export const SETUP_TOOLS: Anthropic.Tool[] = [
  {
    name: "set_hours",
    description: "Set opening hours for one or more days. Use closed=true for a day they are shut.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "array", items: { type: "string" }, description: "Day names, or 'weekdays' (Mon–Fri), 'weekend', 'every day'." },
        open: { type: "string", description: "HH:MM, 24-hour." },
        close: { type: "string", description: "HH:MM, 24-hour." },
        closed: { type: "boolean" },
      },
      required: ["days"],
    },
  },
  {
    name: "add_service",
    description:
      "Add a service they offer, exactly as they described it. Only the name is needed; pass a length or a price only when they gave one. Never guess either.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        duration_min: { type: "number", description: "Minutes, when they said. Needed only when bookings go into Belline's diary; the tool says so." },
        price: { type: "number", description: "In the venue's currency, when they said. Leave out and Belline tells customers the team will confirm the price." },
      },
      required: ["name"],
    },
  },
  {
    name: "edit_service",
    description: "Change a service's name, duration or price. Only pass what the owner changed.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The service as it is called now." },
        new_name: { type: "string" },
        duration_min: { type: "number" },
        price: { type: "number" },
      },
      required: ["name"],
    },
  },
  {
    name: "remove_service",
    description: "Remove a service by name.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "add_staff",
    description: "Add a person who takes bookings. They can do every service unless the owner names which.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        services: { type: "array", items: { type: "string" }, description: "Service names they do, if not all." },
      },
      required: ["name"],
    },
  },
  {
    name: "remove_staff",
    description: "Stop offering bookings with a person, by name.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "set_address",
    description: "Set the venue's address, as the owner gave it.",
    input_schema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
  },
  {
    name: "set_transfer_number",
    description: "The number Belline puts urgent calls through to. Must be in the business's own country.",
    input_schema: { type: "object", properties: { number: { type: "string" } }, required: ["number"] },
  },
  {
    name: "set_escalation",
    description: "The urgent-call number and/or where new booking requests are sent (an email address or a WhatsApp number).",
    input_schema: {
      type: "object",
      properties: { transfer_number: { type: "string" }, notify: { type: "string" } },
    },
  },
  {
    name: "add_faq",
    description: "A question customers ask and the owner's answer, in their words.",
    input_schema: { type: "object", properties: { question: { type: "string" }, answer: { type: "string" } }, required: ["question", "answer"] },
  },
  {
    name: "edit_faq",
    description: "Change the answer to a saved question, or remove it with remove=true.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" }, answer: { type: "string" }, remove: { type: "boolean" } },
      required: ["question"],
    },
  },
  {
    name: "add_policy",
    description: "A rule Belline must follow, e.g. cancellation notice or deposits, in the owner's words.",
    input_schema: { type: "object", properties: { rule: { type: "string" } }, required: ["rule"] },
  },
  {
    name: "set_destination",
    description:
      "Where bookings go: 'requests' (Belline takes the details and the team confirms), 'belline' (Belline's own diary, only if offered), 'google' or 'outlook' (each only once connected). Use only when the owner has chosen.",
    input_schema: {
      type: "object",
      properties: { destination: { type: "string", enum: ["requests", "belline", "google", "outlook"] }, booking_link: { type: "string" } },
      required: ["destination"],
    },
  },
  {
    name: "set_booking_link",
    description: "The owner's own online booking page, given to people in chats. Only for businesses taking requests.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "get_journey",
    description: "Where the owner is in setup: every step, what is done, and what still blocks going live.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "explain_forwarding",
    description: "Exactly how to forward their phone line to Belline, for their carrier and kind of line.",
    input_schema: {
      type: "object",
      properties: {
        carrier: { type: "string", enum: ["du", "eand", "virgin", "other"], description: "eand is e& (Etisalat)." },
        line: { type: "string", enum: ["mobile", "landline", "pbx"] },
      },
      required: ["line"],
    },
  },
  {
    name: "check_widget_install",
    description: "Open a page of the owner's website and say whether Belline's chat snippet is on it.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "help_article",
    description: `The help article for a topic. Topics: ${HELP_ARTICLES.map((a) => a.id).join(", ")}.`,
    input_schema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
  },
  {
    name: "open_exception",
    description:
      "Hand over to the Belline team. Only for: no Belline number available (pool_empty, number_assign_failed), forwarding that failed twice (forwarding_unverified_2x), WhatsApp refused or expired (whatsapp_rejected, whatsapp_token_expired), a final failed payment or a billing question (payment_failed_final, billing_dispute), or when the owner has asked for a person twice (owner_requested_human). Never for anything they can do themselves.",
    input_schema: {
      type: "object",
      properties: { kind: { type: "string" }, reason: { type: "string", description: "One sentence for the team." } },
      required: ["kind", "reason"],
    },
  },
];

function journeyOf(location: Location): Journey {
  return journey(location, factsFrom(location, listCalls(location.id)));
}

/** Everything but the one tool that has to wait on the network. */
export function executeSetupTool(
  locationId: string,
  by: By,
  name: string,
  input: Record<string, unknown>,
  history: SetupMessage[] = [],
): SetupToolResult {
  const location = getLocation(locationId);
  if (!location) return { ok: false, say: "The venue could not be found." };
  const text = (v: unknown, max = 300) => String(v ?? "").trim().slice(0, max);

  switch (name) {
    case "set_hours": {
      const days = dayIndexes(input.days);
      if (!days?.length) return { ok: false, say: "Ask which days they mean." };
      let range: { start: number; end: number } | null = null;
      if (input.closed !== true) {
        const open = parseClock(text(input.open, 5));
        const close = parseClock(text(input.close, 5));
        if (open === null || close === null) return { ok: false, say: "Ask for the opening and closing times." };
        if (close <= open) return { ok: false, say: "The closing time is before the opening time — ask them to check it." };
        range = { start: open, end: close };
      }
      const hours: WeeklyHours = { ...location.hours };
      for (const d of days) hours[d] = range ? [range] : [];
      const next: Location = { ...location, hours };
      // Staff who worked the venue's old hours follow the new ones; anyone
      // with their own pattern keeps it.
      if (next.salon) {
        const same = (a: WeeklyHours) => JSON.stringify(a) === JSON.stringify(location.hours);
        next.salon = { ...next.salon, staff: next.salon.staff.map((s) => (same(s.hours) ? { ...s, hours } : s)) };
      }
      const label = days.map((d) => DAYS[d].slice(0, 3)).join(", ");
      return commit(location, next, by, range ? `hours ${label} ${text(input.open, 5)}–${text(input.close, 5)}` : `closed ${label}`);
    }

    case "add_service": {
      if (!location.salon) return { ok: false, say: "This is a restaurant: tables and service times are set on the How it works page. Say so." };
      const serviceName = text(input.name, 80);
      if (!serviceName) return { ok: false, say: "Ask what the service is called." };
      const durationMin = Math.max(0, Math.round(Number(input.duration_min) || 0));
      const price = Math.max(0, Math.round(Number(input.price) || 0));
      if (durationMin <= 0 && serviceLengthsRequired(location)) {
        return { ok: false, say: "Bookings go into Belline's diary, so ask how long the service takes." };
      }
      const existing = location.salon.services;
      if (existing.some((s) => s.name.toLowerCase() === serviceName.toLowerCase())) {
        return { ok: false, say: `${serviceName} is already on the list. Ask whether they want to change its duration or price instead.` };
      }
      let id = `svc_${slug(serviceName)}`;
      while (existing.some((s) => s.id === id)) id += "_";
      const service = { id, name: serviceName, durationMin, bufferMin: 10, price };
      const everything = new Set(existing.map((s) => s.id));
      const staff = location.salon.staff.map((s) =>
        existing.every((e) => s.serviceIds.includes(e.id)) || everything.size === 0 ? { ...s, serviceIds: [...s.serviceIds, id] } : s,
      );
      const next: Location = { ...location, salon: { ...location.salon, services: [...existing, service], staff } };
      return commit(location, next, by, `service ${serviceName}${durationMin ? `, ${durationMin} min` : ""}${price ? `, ${price}` : ""}`);
    }

    case "edit_service": {
      if (!location.salon) return { ok: false, say: "This venue has no service list." };
      const target = text(input.name, 80).toLowerCase();
      const service = location.salon.services.find((s) => s.name.toLowerCase() === target);
      if (!service) return { ok: false, say: `There is no service called ${text(input.name, 80)}. Read them the list.` };
      const changed = { ...service };
      const newName = text(input.new_name, 80);
      if (newName) {
        if (location.salon.services.some((s) => s.id !== service.id && s.name.toLowerCase() === newName.toLowerCase())) {
          return { ok: false, say: `${newName} is already another service. Ask what they meant.` };
        }
        changed.name = newName;
      }
      if (input.duration_min !== undefined) {
        const d = Math.max(0, Math.round(Number(input.duration_min) || 0));
        if (d <= 0 && serviceLengthsRequired(location)) return { ok: false, say: "Bookings go into Belline's diary, so ask how long the service takes." };
        changed.durationMin = d;
      }
      if (input.price !== undefined) {
        const p = Number(input.price);
        if (!Number.isFinite(p) || p < 0) return { ok: false, say: "Ask for the price again, as a number." };
        changed.price = Math.round(p);
      }
      const next: Location = {
        ...location,
        salon: { ...location.salon, services: location.salon.services.map((s) => (s.id === service.id ? changed : s)) },
      };
      return commit(location, next, by, `service ${changed.name}${changed.durationMin ? `, ${changed.durationMin} min` : ""}${changed.price ? `, ${changed.price}` : ""}`);
    }

    case "remove_service": {
      if (!location.salon) return { ok: false, say: "This venue has no service list." };
      const target = text(input.name, 80).toLowerCase();
      const service = location.salon.services.find((s) => s.name.toLowerCase() === target);
      if (!service) return { ok: false, say: `There is no service called ${text(input.name, 80)}. Read them the list.` };
      const next: Location = {
        ...location,
        salon: {
          ...location.salon,
          services: location.salon.services.filter((s) => s.id !== service.id),
          staff: location.salon.staff.map((s) => ({ ...s, serviceIds: s.serviceIds.filter((x) => x !== service.id) })),
        },
      };
      return commit(location, next, by, `removed service ${service.name}`);
    }

    case "add_staff": {
      if (!location.salon) return { ok: false, say: "This is a restaurant: bookings go to tables, not people. Say so." };
      const staffName = text(input.name, 60);
      if (!staffName) return { ok: false, say: "Ask for their name." };
      const wanted = Array.isArray(input.services) ? input.services.map((s) => String(s).toLowerCase()) : [];
      const services = location.salon.services;
      const serviceIds = wanted.length ? services.filter((s) => wanted.includes(s.name.toLowerCase())).map((s) => s.id) : services.map((s) => s.id);
      if (wanted.length && serviceIds.length === 0) return { ok: false, say: "None of those match the service list. Read them the list and ask again." };
      let id = `stf_${slug(staffName)}`;
      while (location.salon.staff.some((s) => s.id === id)) id += "_";
      const next: Location = {
        ...location,
        salon: { ...location.salon, staff: [...location.salon.staff, { id, name: staffName, serviceIds, hours: location.hours, timeOff: [] }] },
      };
      return commit(location, next, by, `${staffName} taking bookings`);
    }

    case "remove_staff": {
      if (!location.salon) return { ok: false, say: "This is a restaurant: bookings go to tables, not people. Say so." };
      const target = text(input.name, 60).toLowerCase();
      const person = location.salon.staff.find((s) => s.name.toLowerCase() === target);
      if (!person) return { ok: false, say: `Nobody called ${text(input.name, 60)} takes bookings. Read them the list.` };
      const next: Location = { ...location, salon: { ...location.salon, staff: location.salon.staff.filter((s) => s.id !== person.id) } };
      return commit(location, next, by, `${person.name} no longer taking bookings (bookings they already have stay)`);
    }

    case "set_address": {
      const address = text(input.address, 200);
      if (address.length < 5) return { ok: false, say: "Ask for the full address." };
      return commit(location, { ...location, address }, by, `address ${address}`);
    }

    case "set_transfer_number":
    case "set_escalation": {
      const transferNumber = name === "set_transfer_number" ? input.number : input.transfer_number;
      const rules = {
        ...(transferNumber !== undefined ? { transferNumber: text(transferNumber, 40) } : {}),
        ...(input.notify !== undefined ? { notify: text(input.notify, 200) } : {}),
      };
      if (!Object.keys(rules).length) return { ok: false, say: "Ask for the urgent-call number or where requests should be sent." };
      if (rules.transferNumber === "") return { ok: false, say: "That does not look like a phone number. Ask for it again with the country code." };
      // The same validation as the rules step (country, premium ranges,
      // length). Saving here does not confirm the rules step for them.
      const out = applyRules(location, rules);
      if (!out.ok) return { ok: false, say: `Not saved: ${out.error} Ask for it again.` };
      const before = location.onboarding;
      const onboarding = out.location.onboarding && {
        ...out.location.onboarding,
        rulesConfirmedAt: before?.rulesConfirmedAt,
        requestRules: before?.requestRules,
      };
      if (onboarding && !onboarding.rulesConfirmedAt) delete onboarding.rulesConfirmedAt;
      if (onboarding && !onboarding.requestRules) delete onboarding.requestRules;
      const next: Location = { ...out.location, ...(onboarding ? { onboarding } : {}) };
      const what = [
        rules.transferNumber !== undefined ? `urgent calls go to ${next.agent.transferNumber}` : "",
        rules.notify !== undefined ? `requests are sent to ${rules.notify || "nobody"}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      return commit(location, next, by, what);
    }

    case "add_faq": {
      const q = text(input.question, 200);
      const a = text(input.answer, 800);
      if (!q || !a) return { ok: false, say: "Ask for both the question and their answer." };
      return commit(location, { ...location, agent: { ...location.agent, faqs: [...location.agent.faqs, { q, a }] } }, by, `answer to "${q}"`);
    }

    case "edit_faq": {
      const wanted = text(input.question, 200).toLowerCase();
      const faqs = location.agent.faqs;
      const match = faqs.find((f) => f.q.toLowerCase() === wanted) ?? faqs.find((f) => wanted && f.q.toLowerCase().includes(wanted));
      if (!match) {
        return { ok: false, say: `No saved question matches. The saved ones are: ${faqs.map((f) => `"${f.q}"`).join(", ") || "none"}.` };
      }
      if (input.remove === true) {
        return commit(location, { ...location, agent: { ...location.agent, faqs: faqs.filter((f) => f !== match) } }, by, `removed "${match.q}"`);
      }
      const a = text(input.answer, 800);
      if (!a) return { ok: false, say: "Ask what the answer should be now." };
      return commit(location, { ...location, agent: { ...location.agent, faqs: faqs.map((f) => (f === match ? { ...f, a } : f)) } }, by, `answer to "${match.q}"`);
    }

    case "add_policy": {
      const rule = text(input.rule, 400);
      if (!rule) return { ok: false, say: "Ask what the rule is." };
      return commit(location, { ...location, agent: { ...location.agent, policies: [...location.agent.policies, rule] } }, by, `rule: ${rule}`);
    }

    case "set_destination":
    case "set_booking_link": {
      const facts = factsFrom(location, listCalls(location.id));
      const destination = name === "set_booking_link" ? "requests" : text(input.destination, 20);
      if (name === "set_booking_link" && destinationOf(location) !== "requests") {
        return { ok: false, say: "A booking link is for businesses taking requests. Ask whether they want bookings to come in as requests first." };
      }
      if (destination !== "requests" && destination !== "belline" && destination !== "google" && destination !== "outlook") {
        return { ok: false, say: "Ask whether bookings should come in as requests for their team to confirm." };
      }
      const link = text(name === "set_booking_link" ? input.url : input.booking_link, 300);
      const out = recordStep(location, { kind: "destination", destination, ...(link ? { bookingLink: link } : {}) }, facts);
      if (!out.ok) return { ok: false, say: `Not saved: ${out.error}${out.fix ? " The bookings step has the button for it." : ""}` };
      upsertLocation(out.location);
      const saved = out.location.onboarding?.destination;
      return {
        ok: true,
        say: `Saved: bookings ${saved?.kind === "requests" ? "come in as requests" : saved?.kind === "belline" ? "go into Belline's diary" : saved?.kind === "outlook" ? "go into Outlook" : "go into Google Calendar"}${saved?.bookingLink ? `, with the booking link ${saved.bookingLink}` : ""}. Confirm it in one sentence.`,
      };
    }

    case "get_journey": {
      const j = journeyOf(location);
      const tickets = ownerTickets(location.id);
      return {
        ok: true,
        say: [
          `Steps: ${j.steps.map((s) => `${s.n}. ${s.title}${s.done ? " (done)" : ""}`).join("; ")}.`,
          j.next ? `They are on: ${j.next.title}.` : "Every step is done.",
          j.blockers.length ? `Before going live: ${j.blockers.slice(0, 5).map((b) => b.label).join("; ")}.` : "",
          tickets.length ? `Open tickets: ${tickets.map((t) => `${t.ticket} (${t.status})`).join(", ")}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      };
    }

    case "explain_forwarding": {
      const number = bellineNumberOf(location);
      const carrier = text(input.carrier, 10).toLowerCase();
      const line = text(input.line, 10).toLowerCase();
      const to = number ? `your Belline number, ${number}` : "your Belline number";
      const prefix = number
        ? ""
        : "Their Belline number is still being prepared and appears on the Go live page when it is ready; they can arrange forwarding now and use it then. ";
      if (line === "pbx") return { ok: true, say: prefix + PBX_NOTE };
      if (line === "landline") {
        const known = uaeCarriers(number).find((c) => c.id === carrier);
        return {
          ok: true,
          say:
            prefix +
            (known?.landline
              ? known.landline.replace("your Belline number", to)
              : "Landlines are forwarded by the provider. Tell them to call their provider and ask for conditional call forwarding, on no answer and on busy, to " + to + "."),
        };
      }
      if (carrier === "virgin" && !flag("forwarding.carrier.virgin")) {
        return {
          ok: true,
          say:
            prefix +
            `Belline has not checked Virgin Mobile's codes yet, so do not give codes. Tell them to ask Virgin Mobile for conditional call forwarding, on no answer and on busy, to ${to}.`,
        };
      }
      // No number, no codes: a code with a placeholder in it gets dialled as printed.
      if (!forwardingCodes(number).length) {
        return { ok: true, say: `${prefix}The mobile codes appear on the Go live page with the number in them, as soon as the number is ready. Do not give codes before then.` };
      }
      const codes = forwardingCodes(number)
        .map((c) => `${c.when}: dial ${c.dial} (${c.meaning.replace(/\.$/, "")})`)
        .join(". ");
      return {
        ok: true,
        say:
          `${prefix}These are standard codes they dial themselves on their own mobile; nothing is forwarded until they do, and the phone is optional (the website chat alone is enough to go live). ` +
          `On the mobile, dial each code once and press call. ${codes}. Then ring the business number from another phone to test it.`,
      };
    }

    case "help_article": {
      const article = articleFor(text(input.topic, 80));
      if (!article) return { ok: false, say: `No article on that. Topics: ${HELP_ARTICLES.map((a) => a.id).join(", ")}.` };
      return { ok: true, say: `${article.title}. ${article.body}` };
    }

    case "open_exception": {
      const allowed = exceptionAllowed(input.kind, location, history);
      if (!allowed.ok) return { ok: false, say: allowed.say };
      const j = journeyOf(location);
      const opened = openException({
        tenantId: location.tenantId,
        locationId: location.id,
        kind: allowed.kind,
        reason: text(input.reason, 400) || KIND_META[allowed.kind].label,
        context: { step: j.next?.id ?? null, excerpt: excerpt(history) },
        source: "belle",
      });
      return {
        ok: true,
        ticket: opened.exception.ticket,
        say: `Opened ticket ${opened.exception.ticket}. Tell them the ticket number, that the Belline team will contact them at the email address on their account, and that there is nothing else they need to do for this.`,
      };
    }

    case "check_widget_install":
      return { ok: false, say: "Checking a website needs a moment; try again." };

    default:
      return { ok: false, say: `No such tool: ${name}` };
  }
}

/** `executeSetupTool`, plus the website check, which has to fetch the page. */
export async function runSetupTool(
  locationId: string,
  by: By,
  name: string,
  input: Record<string, unknown>,
  history: SetupMessage[] = [],
): Promise<SetupToolResult> {
  if (name !== "check_widget_install") return executeSetupTool(locationId, by, name, input, history);
  const location = getLocation(locationId);
  if (!location) return { ok: false, say: "The venue could not be found." };
  const key = location.embed?.key;
  if (!key) return { ok: false, say: "The website chat has not been created for this business yet. Send them to the Your website page to create it." };
  const out = await checkInstall(String(input.url ?? "").slice(0, 300), key);
  return out.installed
    ? { ok: true, say: "The chat snippet is on that page. It will show as working once the first visitor uses it." }
    : { ok: false, say: `${out.reason ?? "The snippet is not on that page yet."} Offer help_article website-snippet.` };
}

function summary(location: Location): string {
  const hours = [0, 1, 2, 3, 4, 5, 6]
    .map((d) => {
      const ranges = location.hours[d] ?? [];
      return `${DAYS[d].slice(0, 3)} ${ranges.length ? ranges.map((r) => `${Math.floor(r.start / 60)}:${String(r.start % 60).padStart(2, "0")}-${Math.floor(r.end / 60)}:${String(r.end % 60).padStart(2, "0")}`).join(",") : "closed"}`;
    })
    .join("; ");
  const lines = [
    `Business: ${location.name} (${location.vertical}), ${location.address || "no address yet"}`,
    `Hours: ${hours}`,
    location.salon
      ? `Services: ${location.salon.services.map((s) => `${s.name} ${s.durationMin > 0 ? `${s.durationMin}min` : "no length"} ${s.price > 0 ? s.price : "no price"}`).join("; ") || "none"}`
      : "",
    location.salon ? `Staff: ${location.salon.staff.map((s) => s.name).join(", ") || "none"}` : "",
    `Bookings: ${location.onboarding?.destination?.kind ?? "not chosen yet"}`,
    `Urgent calls to: ${location.agent.transferNumber || "not set"}`,
    `Belline number: ${bellineNumberOf(location) || "being prepared"}`,
    `FAQs: ${location.agent.faqs.length}; rules: ${location.agent.policies.length}`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** Where the owner is, for the model: the step, what blocks Go live, test failures and tickets. */
function context(location: Location, j: Journey): string {
  const failures = (location.onboarding?.tests?.results ?? []).filter((r) => !r.passed);
  const tickets = ownerTickets(location.id);
  return [
    j.next ? `Current step: ${j.next.n} of ${j.steps.length}, "${j.next.title}".` : "Setup is finished and the business is live.",
    `Done: ${j.steps.filter((s) => s.done).map((s) => s.title).join(", ") || "nothing yet"}.`,
    j.blockers.length ? `Blocking Go live: ${j.blockers.slice(0, 5).map((b) => b.label).join("; ")}.` : "",
    failures.length ? `Last automatic test failures: ${failures.map((f) => `${f.scenario}${f.detail ? ` (${f.detail})` : ""}`).join("; ")}.` : "",
    tickets.length ? `Open tickets with the team: ${tickets.map((t) => `${t.ticket}, ${t.status}`).join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface HelpCard {
  title: string;
  /** What to do, as a sentence. */
  label: string;
  /** Where the fix button goes. */
  fix: string;
  article?: { title: string; body: string };
}

/** The deterministic help shown when Belle cannot answer: the next thing, its button and its article. */
export function helpCard(location: Location, j: Journey = journeyOf(location), step?: StepId): HelpCard {
  const blocker = j.blockers.find((b) => !step || b.step === step) ?? j.blockers[0];
  const current = (step && j.steps.find((s) => s.id === step)) || j.next;
  const article = articleForStep(step ?? blocker?.step ?? current?.id ?? "first-week");
  if (!current) {
    return { title: "Everything is set up", label: "Belline is live.", fix: "/", ...(article ? { article: { title: article.title, body: article.body } } : {}) };
  }
  const label = current.done ? `${current.title} is done.` : blocker && blocker.step === current.id ? `${blocker.label}.` : `Next: ${current.title}.`;
  return {
    title: `Step ${current.n} · ${current.title}`,
    label,
    fix: blocker && blocker.step === current.id ? blocker.fix : current.url,
    ...(article ? { article: { title: article.title, body: article.body } } : {}),
  };
}

/** The opening line, before the owner has said anything. */
export function setupGreeting(location: Location, step?: StepId): string {
  if (step) {
    const card = helpCard(location, journeyOf(location), step);
    return `Hi, I'm Belle. You're on ${card.title.replace(/^Step \d+ · /, "")}. ${card.label} What would you like to do?`;
  }
  const missing = readiness(location).missing.map((m) => m.label.toLowerCase());
  if (!missing.length) {
    return `Hi, I'm Belle. ${location.name} is set up. Want to change anything — hours, services, who takes bookings, or what I say?`;
  }
  return `Hi, I'm Belle — I'll get ${location.name} ready with you in a few questions. First: ${missing[0]}. What should I put?`;
}

export interface SetupTurn {
  reply: string;
  missing: string[];
  help?: HelpCard;
  ticket?: string;
}

/**
 * One turn of the setup conversation.
 *
 * History is kept by the page and sent each time; the venue itself is re-read
 * on every turn, so the model always sees what is actually saved rather than
 * what it remembers saving.
 */
export async function runSetupTurn(
  locationId: string,
  by: By,
  history: SetupMessage[],
  opts: { model?: SetupModel | null; step?: StepId } = {},
): Promise<SetupTurn> {
  const location = getLocation(locationId);
  if (!location) return { reply: "I could not find that venue.", missing: [] };
  const missing = () => readiness(getLocation(locationId)!).missing.map((m) => m.label);
  const last = [...history].reverse().find((m) => m.role === "user");
  const askedForPerson = Boolean(last && ASKS_FOR_PERSON.test(last.content));
  const asks = humanAsks(history);

  // A second request for a person is answered the same way with or without a
  // model: a ticket, its number, and what happens next. Never a third "are
  // you sure".
  if (askedForPerson && asks >= 2) {
    const out = executeSetupTool(locationId, by, "open_exception", { kind: "owner_requested_human", reason: "Asked for a person twice while setting up." }, history);
    if (out.ticket) {
      return {
        reply: `I've passed this to the Belline team. Your ticket is ${out.ticket}. They'll contact you at the email address on your account, so there's nothing else you need to do for this. You can keep setting up in the meantime.`,
        missing: missing(),
        ticket: out.ticket,
      };
    }
  }

  // Tests inject a model; otherwise the real one, only when it is switched on
  // and never under stubs, where the fetch guard would stop it anyway.
  const model = opts.model !== undefined ? opts.model : flag("import.model") && !flag("stubs") ? anthropicSetupModel : null;

  if (!model) {
    raiseException("model:setup_assistant_off", "setup assistant used without a model switched on");
    const card = helpCard(location, journeyOf(location), opts.step);
    const more = askedForPerson ? " If you would still like a person from Belline, say so again and I will pass it on." : "";
    return {
      reply: `Belle's setup help is not switched on yet, so here is what to do next. ${card.label}${card.article ? ` ${card.article.body}` : ""} You can finish every step yourself on the setup pages.${more}`,
      missing: missing(),
      help: card,
    };
  }

  const messages: Anthropic.MessageParam[] = history.slice(-30).map((m) => ({ role: m.role, content: m.content }));
  let ticket: string | undefined;

  for (let round = 0; round < 6; round++) {
    const venue = getLocation(locationId)!;
    const j = journeyOf(venue);
    const system =
      `You are Belle, helping the owner of ${venue.name} set up Belline, their AI receptionist. ` +
      "Be warm, brief and practical. Ask one short question at a time, starting with what is still missing. " +
      "As soon as the owner gives an answer, save it with a tool, then confirm what you saved in one sentence and move to the next missing thing. " +
      "Save only what the owner actually said — never invent a price, duration, name, rule or hour. If something is ambiguous, ask. " +
      "If a tool says it was not saved, explain why in plain words and ask for the corrected detail. " +
      "When they are stuck, use explain_forwarding, check_widget_install or help_article and walk them through it yourself. " +
      "Only open_exception for the kinds it lists; never promise a person otherwise, and never invent a ticket number. " +
      (askedForPerson ? "The owner has just asked for a person, once. Help with what they are stuck on, and say that if they still want a person they can ask again. " : "") +
      "When nothing is missing, say the next steps are to forward their phone line (the Go live page) and to add the chat and voice button to their website (the Your website page).\n\n" +
      `${context(venue, j)}\n\nStill missing: ${missing().join(", ") || "nothing"}\n\nWhat is saved now:\n${summary(venue)}`;

    const response = await model({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system,
      tools: SETUP_TOOLS,
      messages,
    });

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (!toolUses.length) {
      const reply = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim();
      return { reply: reply || "Done. What next?", missing: missing(), ...(ticket ? { ticket } : {}) };
    }

    messages.push({
      role: "assistant",
      content: response.content
        .filter((b) => b.type === "text" || b.type === "tool_use")
        .map((b): Anthropic.ContentBlockParam =>
          b.type === "text"
            ? { type: "text", text: b.text ?? "" }
            : { type: "tool_use", id: b.id ?? "", name: b.name ?? "", input: (b.input ?? {}) as Record<string, unknown> },
        ),
    });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const out = await runSetupTool(locationId, by, use.name ?? "", (use.input ?? {}) as Record<string, unknown>, history);
      if (out.ticket) ticket = out.ticket;
      results.push({ type: "tool_result", tool_use_id: use.id ?? "", content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }

  return { reply: "I've saved what you told me. What else should I set up?", missing: missing(), ...(ticket ? { ticket } : {}) };
}
