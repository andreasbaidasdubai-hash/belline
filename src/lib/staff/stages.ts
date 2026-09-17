import type { LeadStatus } from "../leads";

/**
 * One set of stages for every lead, whichever store it lives in.
 *
 * Enquiries and Belle's leads are JSON rows with a four-value status; the
 * prospects the agents found are Postgres rows with a thirteen-value enum. A
 * salesperson should not have to know which is which, so both are read into
 * the eight stages below and a change is written back to the record it came
 * from, in that record's own vocabulary.
 *
 * Every write lands on a value that reads back as the stage chosen, so a
 * stage set here is the stage shown on the next page load. The check proves
 * the round trip for every stage in both stores.
 */

export const STAGES = ["new", "contacted", "demo_sent", "demo_watched", "trial", "customer", "lost", "do_not_contact"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  new: "New",
  contacted: "Contacted",
  demo_sent: "Demo sent",
  demo_watched: "Demo watched",
  trial: "Trial",
  customer: "Customer",
  lost: "Lost",
  do_not_contact: "Do not contact",
};

export function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

// --- the JSON lead store ------------------------------------------------------

/**
 * JSON statuses. The four the enquiry form has always written stay readable:
 * `booked` meant a call was booked with them, which is contact made, and
 * `closed` meant nothing came of it.
 */
export function stageFromJson(status: LeadStatus | string | undefined): Stage {
  switch (status) {
    case "contacted":
    case "booked":
      return "contacted";
    case "closed":
      return "lost";
    default:
      return isStage(status) ? status : "new";
  }
}

/** The JSON lead status is the shared stage itself; LeadStatus was widened to hold it. */
export function jsonStatusFor(stage: Stage): LeadStatus {
  return stage;
}

// --- the Postgres pipeline ----------------------------------------------------

export const DB_STAGES = [
  "discovered", "researching", "qualified", "contacted", "follow_up", "replied",
  "interested", "demo", "meeting_booked", "pilot", "customer", "lost", "do_not_contact",
] as const;
export type DbStage = (typeof DB_STAGES)[number];

export function stageFromDb(stage: string): Stage {
  switch (stage) {
    case "discovered":
    case "researching":
    case "qualified":
      return "new";
    case "contacted":
    case "follow_up":
    case "replied":
      return "contacted";
    case "demo":
      return "demo_sent";
    // Interest after the demo, or a call booked off the back of it.
    case "interested":
    case "meeting_booked":
      return "demo_watched";
    case "pilot":
      return "trial";
    case "customer":
      return "customer";
    case "lost":
      return "lost";
    case "do_not_contact":
      return "do_not_contact";
    default:
      return "new";
  }
}

/**
 * The enum value to write. A lead already somewhere inside the chosen stage
 * keeps its finer value: moving a `replied` lead to Contacted changes nothing.
 */
export function dbStageFor(stage: Stage, current?: string): DbStage {
  if (current && (DB_STAGES as readonly string[]).includes(current) && stageFromDb(current) === stage) return current as DbStage;
  switch (stage) {
    case "new":
      return "qualified";
    case "contacted":
      return "contacted";
    case "demo_sent":
      return "demo";
    case "demo_watched":
      return "interested";
    case "trial":
      return "pilot";
    case "customer":
      return "customer";
    case "lost":
      return "lost";
    case "do_not_contact":
      return "do_not_contact";
  }
}
