import Anthropic from "@anthropic-ai/sdk";
import type { Location, User, WeeklyHours } from "../types";
import { getLocation, upsertLocation } from "../store";
import { publish } from "../brain";
import { isBlocking, validateVenue } from "../booking/config";
import { normalisePhone } from "../leads";
import { parseClock } from "../time";
import { readiness } from "./index";

/**
 * Setting a venue up by talking to Belle.
 *
 * The website reader drafts most of a venue; this is for everything it could
 * not read and everything the owner wants to change. The owner answers in
 * their own words, and every answer becomes a small, validated change:
 *
 *   Each tool builds the venue it would produce and runs the same gate the
 *   venue editor uses (`validateVenue`). A change that would leave the diary
 *   unable to take a booking is refused with the reason, which Belle says in
 *   plain words and asks again — never a crash, never a silent save.
 *
 *   Every accepted change is published as a Business Brain version authored
 *   by the owner with the note "Set up with Belle", so it is on the history
 *   and one click from being reverted.
 *
 *   Only what the owner said is saved. The prompt says so, and the tools
 *   cannot invent anything the model did not pass them.
 */

type By = Pick<User, "id" | "name">;

export interface SetupToolResult {
  ok: boolean;
  say: string;
  missing?: string[];
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function dayIndexes(raw: unknown): number[] | null {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = new Set<number>();
  for (const item of list) {
    const word = String(item ?? "").trim().toLowerCase();
    if (word === "every day" || word === "everyday" || word === "daily") [0, 1, 2, 3, 4, 5, 6].forEach((d) => out.add(d));
    // The UAE working week.
    else if (word === "weekdays") [1, 2, 3, 4, 5].forEach((d) => out.add(d));
    else if (word === "weekend") [0, 6].forEach((d) => out.add(d));
    else if (/^[0-6]$/.test(word)) out.add(Number(word));
    else {
      const i = DAYS.findIndex((d) => d.startsWith(word.slice(0, 3)) && word.length >= 3);
      if (i < 0) return null;
      out.add(i);
    }
  }
  return [...out].sort();
}

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
    description: "Add a service they offer, exactly as they described it.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        duration_min: { type: "number" },
        price: { type: "number", description: "In the venue's currency. 0 if they do not want a price quoted." },
      },
      required: ["name", "duration_min", "price"],
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
    name: "set_address",
    description: "Set the venue's address, as the owner gave it.",
    input_schema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
  },
  {
    name: "set_transfer_number",
    description: "The number Belline puts urgent calls through to.",
    input_schema: { type: "object", properties: { number: { type: "string" } }, required: ["number"] },
  },
  {
    name: "add_faq",
    description: "A question customers ask and the owner's answer, in their words.",
    input_schema: { type: "object", properties: { question: { type: "string" }, answer: { type: "string" } }, required: ["question", "answer"] },
  },
  {
    name: "add_policy",
    description: "A rule Belline must follow, e.g. cancellation notice or deposits, in the owner's words.",
    input_schema: { type: "object", properties: { rule: { type: "string" } }, required: ["rule"] },
  },
];

export function executeSetupTool(
  locationId: string,
  by: By,
  name: string,
  input: Record<string, unknown>,
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
      const durationMin = Math.round(Number(input.duration_min));
      const price = Math.max(0, Math.round(Number(input.price) || 0));
      if (!Number.isFinite(durationMin) || durationMin <= 0) return { ok: false, say: "Ask how long the service takes." };
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
      return commit(location, next, by, `service ${serviceName}, ${durationMin} min, ${price}`);
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

    case "set_address": {
      const address = text(input.address, 200);
      if (address.length < 5) return { ok: false, say: "Ask for the full address." };
      return commit(location, { ...location, address }, by, `address ${address}`);
    }

    case "set_transfer_number": {
      const { phone, valid } = normalisePhone(text(input.number, 40));
      if (!valid) return { ok: false, say: "That does not look like a phone number. Ask for it again with the country code." };
      return commit(location, { ...location, agent: { ...location.agent, transferNumber: phone } }, by, `urgent calls go to ${phone}`);
    }

    case "add_faq": {
      const q = text(input.question, 200);
      const a = text(input.answer, 800);
      if (!q || !a) return { ok: false, say: "Ask for both the question and their answer." };
      return commit(location, { ...location, agent: { ...location.agent, faqs: [...location.agent.faqs, { q, a }] } }, by, `answer to "${q}"`);
    }

    case "add_policy": {
      const rule = text(input.rule, 400);
      if (!rule) return { ok: false, say: "Ask what the rule is." };
      return commit(location, { ...location, agent: { ...location.agent, policies: [...location.agent.policies, rule] } }, by, `rule: ${rule}`);
    }

    default:
      return { ok: false, say: `No such tool: ${name}` };
  }
}

export interface SetupMessage {
  role: "user" | "assistant";
  content: string;
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
    location.salon ? `Services: ${location.salon.services.map((s) => `${s.name} ${s.durationMin}min ${s.price}`).join("; ") || "none"}` : "",
    location.salon ? `Staff: ${location.salon.staff.map((s) => s.name).join(", ") || "none"}` : "",
    `Urgent calls to: ${location.agent.transferNumber || "not set"}`,
    `FAQs: ${location.agent.faqs.length}; rules: ${location.agent.policies.length}`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** The opening line, before the owner has said anything. */
export function setupGreeting(location: Location): string {
  const missing = readiness(location).missing.map((m) => m.label.toLowerCase());
  if (!missing.length) {
    return `Hi, I'm Belle. ${location.name} is set up. Want to change anything — hours, services, who takes bookings, or what I say?`;
  }
  return `Hi, I'm Belle — I'll get ${location.name} ready with you in a few questions. First: ${missing[0]}. What should I put?`;
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
): Promise<{ reply: string; missing: string[] }> {
  const location = getLocation(locationId);
  if (!location) return { reply: "I could not find that venue.", missing: [] };
  const missing = () => readiness(getLocation(locationId)!).missing.map((m) => m.label);

  if (!process.env.ANTHROPIC_API_KEY) {
    return { reply: "The setup assistant is not switched on here yet (no ANTHROPIC_API_KEY). You can fill everything in on the How it works and Agent pages.", missing: missing() };
  }

  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = history.slice(-30).map((m) => ({ role: m.role, content: m.content }));

  for (let round = 0; round < 6; round++) {
    const venue = getLocation(locationId)!;
    const system =
      `You are Belle, helping the owner of ${venue.name} set up Belline, their AI receptionist. ` +
      "Be warm, brief and practical. Ask one short question at a time, starting with what is still missing. " +
      "As soon as the owner gives an answer, save it with a tool, then confirm what you saved in one sentence and move to the next missing thing. " +
      "Save only what the owner actually said — never invent a price, duration, name, rule or hour. If something is ambiguous, ask. " +
      "If a tool says it was not saved, explain why in plain words and ask for the corrected detail. " +
      "When nothing is missing, say the next steps are to forward their phone line (the Go live page) and to add the chat and voice button to their website (the Your website page).\n\n" +
      `Still missing: ${missing().join(", ") || "nothing"}\n\nWhat is saved now:\n${summary(venue)}`;

    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system,
      tools: SETUP_TOOLS,
      messages,
    });

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUses.length || response.stop_reason !== "tool_use") {
      const reply = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { reply: reply || "Done. What next?", missing: missing() };
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: toolUses.map((use) => ({
        type: "tool_result" as const,
        tool_use_id: use.id,
        content: JSON.stringify(executeSetupTool(locationId, by, use.name, (use.input ?? {}) as Record<string, unknown>)),
      })),
    });
  }

  return { reply: "I've saved what you told me. What else should I set up?", missing: missing() };
}
