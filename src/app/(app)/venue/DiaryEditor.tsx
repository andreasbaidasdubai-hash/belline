"use client";

import { useState } from "react";
import type { Resource, SalonConfig, SalonService, StaffMember } from "@/lib/types";
import type { Terms } from "@/lib/verticals";
import { Cell, Field, NumberBox, Panel, Row, TextBox, Toggle, WEEKDAYS } from "./fields";
import { minutesToClock, parseClock } from "@/lib/time";

/**
 * The price list, the team, and the rooms.
 *
 * This is the whole salon/clinic engine made editable, and the ordering is
 * deliberate: services first because everything else references them, the team
 * second because qualifications point at services, rooms last because they are
 * the part nobody changes twice a year.
 *
 * The two features worth the screen space they take are stages and the second
 * person. Both are invisible in every competitor's settings page, both are
 * what a real diary actually does, and neither can be expressed by a venue
 * that is only offered "how long does it take".
 */

let counter = 0;
function freshId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter}`;
}

export default function DiaryEditor({
  config,
  onChange,
  currency,
  t,
  problems,
}: {
  config: SalonConfig;
  onChange: (next: SalonConfig) => void;
  currency: string;
  t: Terms;
  problems: Map<string, string>;
}) {
  const [open, setOpen] = useState<string | null>(null);

  const types = [...new Set(config.resources.map((r) => r.type))];

  function setServices(services: SalonService[]) {
    onChange({ ...config, services });
  }
  function patchService(id: string, patch: Partial<SalonService>) {
    setServices(config.services.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }
  function setStaff(staff: StaffMember[]) {
    onChange({ ...config, staff });
  }
  function patchStaff(id: string, patch: Partial<StaffMember>) {
    setStaff(config.staff.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  const roles = [...new Set(config.staff.map((p) => p.role).filter(Boolean))] as string[];

  return (
    <>
      {/* ---------------------------------------------------------------- */}
      <Panel
        title={`${cap(t.services)}`}
        hint={`What can be booked, how long it takes and what it costs. A ${t.staff} can have their own timing and price — see ${t.staffPlural} below.`}
        right={
          <button
            className="btn"
            style={{ padding: "5px 11px", fontSize: 12 }}
            onClick={() =>
              setServices([
                ...config.services,
                { id: freshId("svc"), name: "", durationMin: 30, bufferMin: 0, price: 0 },
              ])
            }
          >
            Add {t.service}
          </button>
        }
      >
        {config.services.length === 0 && (
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            Nothing on the list yet, so nothing can be booked.
          </p>
        )}

        {config.services.map((service) => {
          const expanded = open === service.id;
          return (
            <Row
              key={service.id}
              onRemove={() => setServices(config.services.filter((s) => s.id !== service.id))}
            >
              <Cell label="Name" width={200}>
                <TextBox
                  value={service.name}
                  placeholder={`e.g. ${t.service}`}
                  onChange={(v) => patchService(service.id, { name: v })}
                />
              </Cell>
              <Cell label="Takes" width={120}>
                <NumberBox
                  value={service.durationMin}
                  onChange={(v) => patchService(service.id, { durationMin: v ?? 0 })}
                  suffix="min"
                  width={58}
                />
              </Cell>
              <Cell label="Turnaround" width={120}>
                <NumberBox
                  value={service.bufferMin}
                  onChange={(v) => patchService(service.id, { bufferMin: v ?? 0 })}
                  suffix="min"
                  width={58}
                />
              </Cell>
              <Cell label="Price" width={130}>
                <NumberBox
                  value={service.price}
                  onChange={(v) => patchService(service.id, { price: v ?? 0 })}
                  suffix={currency}
                  width={66}
                />
              </Cell>
              <Cell label="Brings them back in" width={140}>
                <NumberBox
                  value={service.recallDays}
                  onChange={(v) => patchService(service.id, { recallDays: v })}
                  suffix="days"
                  width={58}
                />
              </Cell>

              <button
                className="btn"
                style={{ padding: "6px 12px", fontSize: 12 }}
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : service.id)}
              >
                {expanded ? "Less" : "More"}
              </button>

              {problemsFor(problems, `service.${service.id}`).map((p) => (
                <div key={p} style={{ color: "var(--bad)", fontSize: 11.5, width: "100%" }}>
                  {p}
                </div>
              ))}

              {expanded && (
                <div
                  style={{
                    width: "100%",
                    marginTop: 12,
                    paddingTop: 12,
                    borderTop: "1px solid var(--border-soft)",
                  }}
                >
                  <Stages
                    service={service}
                    onChange={(phases) => patchService(service.id, { phases })}
                    staffWord={t.staff}
                  />

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-end", marginTop: 14 }}>
                    <Cell label="First visit takes" width={150}>
                      <NumberBox
                        value={service.newGuestDurationMin}
                        onChange={(v) => patchService(service.id, { newGuestDurationMin: v })}
                        suffix="min"
                        width={58}
                      />
                    </Cell>
                    {types.length > 0 && (
                      <Cell label="Needs" width={230}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, paddingTop: 4 }}>
                          {types.map((type) => {
                            const on = [
                              ...(service.resourceType ? [service.resourceType] : []),
                              ...(service.resourceTypes ?? []),
                            ].includes(type);
                            return (
                              <Toggle
                                key={type}
                                checked={on}
                                label={humanise(type)}
                                onChange={(want) => {
                                  const current = new Set([
                                    ...(service.resourceType ? [service.resourceType] : []),
                                    ...(service.resourceTypes ?? []),
                                  ]);
                                  if (want) current.add(type);
                                  else current.delete(type);
                                  patchService(service.id, {
                                    // Collapsed into the list form, so there is
                                    // one place a resource requirement lives.
                                    resourceType: undefined,
                                    resourceTypes: current.size > 0 ? [...current] : undefined,
                                  });
                                }}
                              />
                            );
                          })}
                        </div>
                      </Cell>
                    )}
                    {roles.length > 0 && (
                      <Cell label="Only a" width={170}>
                        <select
                          value={service.role ?? ""}
                          onChange={(e) =>
                            patchService(service.id, { role: e.target.value || undefined })
                          }
                        >
                          <option value="">anyone qualified</option>
                          {roles.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      </Cell>
                    )}
                    <div style={{ paddingBottom: 9, display: "flex", gap: 16 }}>
                      <Toggle
                        checked={Boolean(service.addOnOnly)}
                        label="Add-on only"
                        onChange={(v) => patchService(service.id, { addOnOnly: v || undefined })}
                      />
                      <Toggle
                        checked={service.online !== false}
                        label="Agent may book it"
                        onChange={(v) => patchService(service.id, { online: v ? undefined : false })}
                      />
                    </div>
                  </div>

                  {roles.length > 0 && (
                    <Secondary
                      service={service}
                      roles={roles}
                      onChange={(secondary) => patchService(service.id, { secondary })}
                    />
                  )}
                </div>
              )}
            </Row>
          );
        })}
      </Panel>

      {/* ---------------------------------------------------------------- */}
      <Panel
        title={cap(t.staffPlural)}
        hint="Who does what, when they are in, and what they charge. A blank price or timing means the list one."
        right={
          <button
            className="btn"
            style={{ padding: "5px 11px", fontSize: 12 }}
            onClick={() =>
              setStaff([
                ...config.staff,
                { id: freshId("st"), name: "", serviceIds: [], hours: {}, timeOff: [] },
              ])
            }
          >
            Add {t.staff}
          </button>
        }
      >
        {config.staff.map((person) => (
          <Person
            key={person.id}
            person={person}
            services={config.services}
            currency={currency}
            expanded={open === person.id}
            onToggle={() => setOpen(open === person.id ? null : person.id)}
            onChange={(patch) => patchStaff(person.id, patch)}
            onRemove={() => setStaff(config.staff.filter((p) => p.id !== person.id))}
            problems={problemsFor(problems, `staff.${person.id}`)}
          />
        ))}
      </Panel>

      {/* ---------------------------------------------------------------- */}
      <Panel
        title="Rooms and equipment"
        hint="Anything shared that a booking ties up: a chair, a surgery, a machine. Two services needing the same one cannot run at once."
        right={
          <button
            className="btn"
            style={{ padding: "5px 11px", fontSize: 12 }}
            onClick={() =>
              onChange({
                ...config,
                resources: [...config.resources, { id: freshId("res"), name: "", type: "" }],
              })
            }
          >
            Add
          </button>
        }
      >
        {config.resources.length === 0 && (
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            Nothing shared. Add a room or a machine if two bookings could ever contend for one.
          </p>
        )}
        {config.resources.map((resource) => (
          <Row
            key={resource.id}
            onRemove={() =>
              onChange({
                ...config,
                resources: config.resources.filter((r) => r.id !== resource.id),
              })
            }
          >
            <Cell label="Name" width={200}>
              <TextBox
                value={resource.name}
                placeholder="e.g. Surgery 1"
                onChange={(v) => patchResource(config, onChange, resource, { name: v })}
              />
            </Cell>
            <Cell label="Type" width={200}>
              <TextBox
                value={resource.type}
                placeholder="e.g. surgery"
                onChange={(v) => patchResource(config, onChange, resource, { type: v })}
              />
            </Cell>
            <Cell label="Holds at once" width={130}>
              <NumberBox
                value={resource.capacity}
                onChange={(v) => patchResource(config, onChange, resource, { capacity: v })}
                placeholder="1"
                min={1}
                width={58}
              />
            </Cell>
            {problemsFor(problems, `resource.${resource.id}`).map((p) => (
              <div key={p} style={{ color: "var(--bad)", fontSize: 11.5, width: "100%" }}>
                {p}
              </div>
            ))}
          </Row>
        ))}
      </Panel>

      {/* ---------------------------------------------------------------- */}
      <Panel title="How the diary fills" hint="Two decisions that are the owner's rather than ours.">
        <Field
          label="Who gets the next booking"
          hint={
            config.assignment === "pack"
              ? "Whoever it leaves the fewest dead minutes with. The team's day closes up and you sell more hours — but somebody may go home early."
              : `Whoever is least busy. Fair, and what a commission-based team will expect.`
          }
        >
          <select
            value={config.assignment ?? "spread"}
            onChange={(e) =>
              onChange({ ...config, assignment: e.target.value === "pack" ? "pack" : "spread" })
            }
          >
            <option value="spread">Spread the work evenly</option>
            <option value="pack">Close up the gaps</option>
          </select>
        </Field>

        <Field
          label="Booking grid"
          hint="The steps times are offered on. Fifteen minutes suits almost everybody."
        >
          <NumberBox
            value={config.slotMinutes}
            onChange={(v) => onChange({ ...config, slotMinutes: v ?? 15 })}
            suffix="minutes"
            width={70}
          />
        </Field>

        <div style={{ marginTop: 4 }}>
          <Toggle
            checked={Boolean(config.dovetail)}
            label={`Book somebody else into a ${t.staff}'s waiting time`}
            onChange={(v) => onChange({ ...config, dovetail: v || undefined })}
          />
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5, maxWidth: 640 }}>
            While a colour develops or an anaesthetic takes, the chair is occupied and the{" "}
            {t.staff} is not. With this on, that stretch is sold to somebody else — which is the
            difference between three {t.guests} in a morning and two. The {t.staff} will see two
            overlapping appointments in their column, so turn it on once they know why.
            {!config.services.some((s) => (s.phases ?? []).some((p) => p.staffFree)) &&
              " Nothing on the list has such a stretch yet — set the stages on a service under More."}
          </div>
        </div>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * The stages of a service.
 *
 * The whole feature in one control. A venue that has never been offered this
 * does not know to ask for it, so the hint has to do the explaining and the
 * default has to be the ordinary case: one stage, everybody present.
 */
function Stages({
  service,
  onChange,
  staffWord,
}: {
  service: SalonService;
  onChange: (phases: SalonService["phases"]) => void;
  staffWord: string;
}) {
  const phases = service.phases ?? [];
  const total = phases.reduce((n, p) => n + p.durationMin, 0);
  const off = phases.length === 0;

  return (
    <div>
      <Toggle
        checked={!off}
        label="This runs in stages"
        onChange={(on) =>
          onChange(
            on
              ? [
                  { name: "Apply", durationMin: Math.round(service.durationMin / 3) },
                  {
                    name: "Wait",
                    durationMin: Math.round(service.durationMin / 3),
                    staffFree: true,
                  },
                  {
                    name: "Finish",
                    durationMin:
                      service.durationMin - 2 * Math.round(service.durationMin / 3),
                  },
                ]
              : undefined,
          )
        }
      />
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5, maxWidth: 620 }}>
        For anything with waiting in the middle — colour developing, a mask, an anaesthetic taking.
        Tick the stages where the {staffWord} is free and the stretch becomes sellable.
      </div>

      {!off && (
        <div style={{ marginTop: 10 }}>
          {phases.map((phase, index) => (
            <div
              key={index}
              style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 7 }}
            >
              <input
                value={phase.name}
                style={{ width: 150 }}
                onChange={(e) =>
                  onChange(phases.map((p, i) => (i === index ? { ...p, name: e.target.value } : p)))
                }
              />
              <NumberBox
                value={phase.durationMin}
                onChange={(v) =>
                  onChange(
                    phases.map((p, i) => (i === index ? { ...p, durationMin: v ?? 0 } : p)),
                  )
                }
                suffix="min"
                width={58}
              />
              <Toggle
                checked={Boolean(phase.staffFree)}
                label={`${staffWord} is free`}
                onChange={(v) =>
                  onChange(
                    phases.map((p, i) => (i === index ? { ...p, staffFree: v || undefined } : p)),
                  )
                }
              />
              <button
                className="btn"
                style={{ padding: "4px 9px", fontSize: 11.5 }}
                onClick={() => onChange(phases.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </div>
          ))}

          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
            <button
              className="btn"
              style={{ padding: "5px 11px", fontSize: 12 }}
              onClick={() => onChange([...phases, { name: "Stage", durationMin: 15 }])}
            >
              Add a stage
            </button>
            <span
              className="muted"
              style={{ fontSize: 11.5, color: total === service.durationMin ? undefined : "var(--bad)" }}
            >
              {total} of {service.durationMin} minutes accounted for
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** The dentist who steps into a hygiene appointment for the exam. */
function Secondary({
  service,
  roles,
  onChange,
}: {
  service: SalonService;
  roles: string[];
  onChange: (value: SalonService["secondary"]) => void;
}) {
  const secondary = service.secondary;
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-soft)" }}>
      <Toggle
        checked={Boolean(secondary)}
        label="A second person is needed partway through"
        onChange={(on) =>
          onChange(
            on
              ? { role: roles[0], atMin: Math.max(0, service.durationMin - 15), durationMin: 10 }
              : undefined,
          )
        }
      />
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5, maxWidth: 620 }}>
        A hygiene visit is an hour of the hygienist containing ten minutes of the dentist, for the
        exam. Without this the dentist's whole hour is blocked for every cleaning.
      </div>
      {secondary && (
        <div style={{ display: "flex", gap: 14, alignItems: "flex-end", marginTop: 10 }}>
          <Cell label="Who" width={170}>
            <select
              value={secondary.role}
              onChange={(e) => onChange({ ...secondary, role: e.target.value })}
            >
              {roles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </Cell>
          <Cell label="Joins after" width={130}>
            <NumberBox
              value={secondary.atMin}
              onChange={(v) => onChange({ ...secondary, atMin: v ?? 0 })}
              suffix="min"
              width={58}
            />
          </Cell>
          <Cell label="For" width={120}>
            <NumberBox
              value={secondary.durationMin}
              onChange={(v) => onChange({ ...secondary, durationMin: v ?? 0 })}
              suffix="min"
              width={58}
            />
          </Cell>
        </div>
      )}
    </div>
  );
}

/** One member of the team: what they do, when they are in, what they charge. */
function Person({
  person,
  services,
  currency,
  expanded,
  onToggle,
  onChange,
  onRemove,
  problems,
}: {
  person: StaffMember;
  services: SalonService[];
  currency: string;
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<StaffMember>) => void;
  onRemove: () => void;
  problems: string[];
}) {
  return (
    <Row onRemove={onRemove}>
      <Cell label="Name" width={180}>
        <TextBox value={person.name} onChange={(v) => onChange({ name: v })} />
      </Cell>
      <Cell label="Role" width={170}>
        <TextBox
          value={person.role ?? ""}
          placeholder="e.g. dentist"
          onChange={(v) => onChange({ role: v || undefined })}
        />
      </Cell>
      <div style={{ paddingBottom: 9 }}>
        <Toggle
          checked={Boolean(person.requestOnly)}
          label="Only when asked for by name"
          onChange={(v) => onChange({ requestOnly: v || undefined })}
        />
      </div>
      <button
        className="btn"
        style={{ padding: "6px 12px", fontSize: 12 }}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {expanded ? "Less" : "More"}
      </button>

      {problems.map((p) => (
        <div key={p} style={{ color: "var(--bad)", fontSize: 11.5, width: "100%" }}>
          {p}
        </div>
      ))}

      {expanded && (
        <div style={{ width: "100%", marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border-soft)" }}>
          <label>Can do</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
            {services.map((service) => (
              <Toggle
                key={service.id}
                checked={person.serviceIds.includes(service.id)}
                label={service.name || "Untitled"}
                onChange={(on) =>
                  onChange({
                    serviceIds: on
                      ? [...person.serviceIds, service.id]
                      : person.serviceIds.filter((id) => id !== service.id),
                  })
                }
              />
            ))}
          </div>

          <label>Hours</label>
          <Week
            hours={person.hours}
            breaks={person.breaks}
            onHours={(hours) => onChange({ hours })}
            onBreaks={(breaks) => onChange({ breaks })}
          />

          <div style={{ marginTop: 16 }}>
            <label>Their own timing and price</label>
            <div className="muted" style={{ fontSize: 11.5, marginBottom: 8, lineHeight: 1.45 }}>
              Blank uses the list. This is how level-based pricing is actually sold — a senior is
              quicker and charges more for the same thing.
            </div>
            {person.serviceIds.map((id) => {
              const service = services.find((s) => s.id === id);
              if (!service) return null;
              return (
                <div
                  key={id}
                  style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 6 }}
                >
                  <span style={{ width: 190, fontSize: 12.5 }}>{service.name}</span>
                  <NumberBox
                    value={person.durationOverrides?.[id]}
                    onChange={(v) =>
                      onChange({ durationOverrides: patchMap(person.durationOverrides, id, v) })
                    }
                    placeholder={String(service.durationMin)}
                    suffix="min"
                    width={58}
                  />
                  <NumberBox
                    value={person.priceOverrides?.[id]}
                    onChange={(v) =>
                      onChange({ priceOverrides: patchMap(person.priceOverrides, id, v) })
                    }
                    placeholder={String(service.price)}
                    suffix={currency}
                    width={66}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Row>
  );
}

/** A week of shifts, with the break that comes out of each day. */
function Week({
  hours,
  breaks,
  onHours,
  onBreaks,
}: {
  hours: StaffMember["hours"];
  breaks: StaffMember["breaks"];
  onHours: (value: StaffMember["hours"]) => void;
  onBreaks: (value: StaffMember["breaks"]) => void;
}) {
  return (
    <div style={{ display: "grid", gap: 5 }}>
      {WEEKDAYS.map((name, day) => {
        const shift = hours[day]?.[0];
        const brk = breaks?.[day]?.[0];
        return (
          <div key={name} style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 12.5 }}>
            <span style={{ width: 38 }}>{name}</span>
            <Toggle
              checked={Boolean(shift)}
              label=""
              onChange={(on) =>
                onHours({ ...hours, [day]: on ? [{ start: 9 * 60, end: 18 * 60 }] : [] })
              }
            />
            {shift ? (
              <>
                <Clock
                  value={shift.start}
                  onChange={(v) => onHours({ ...hours, [day]: [{ ...shift, start: v }] })}
                />
                <span className="muted">to</span>
                <Clock
                  value={shift.end}
                  onChange={(v) => onHours({ ...hours, [day]: [{ ...shift, end: v }] })}
                />
                <span className="muted" style={{ marginLeft: 10 }}>
                  break
                </span>
                {brk ? (
                  <>
                    <Clock
                      value={brk.start}
                      onChange={(v) => onBreaks({ ...(breaks ?? {}), [day]: [{ ...brk, start: v }] })}
                    />
                    <span className="muted">to</span>
                    <Clock
                      value={brk.end}
                      onChange={(v) => onBreaks({ ...(breaks ?? {}), [day]: [{ ...brk, end: v }] })}
                    />
                    <button
                      className="btn"
                      style={{ padding: "3px 8px", fontSize: 11 }}
                      onClick={() => onBreaks({ ...(breaks ?? {}), [day]: [] })}
                    >
                      ×
                    </button>
                  </>
                ) : (
                  <button
                    className="btn"
                    style={{ padding: "3px 9px", fontSize: 11 }}
                    onClick={() =>
                      onBreaks({ ...(breaks ?? {}), [day]: [{ start: 13 * 60, end: 13 * 60 + 45 }] })
                    }
                  >
                    add
                  </button>
                )}
              </>
            ) : (
              <span className="muted">off</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Clock({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <input
      defaultValue={minutesToClock(value)}
      style={{ width: 74 }}
      onBlur={(e) => {
        const min = parseClock(e.target.value);
        if (min === null) {
          e.target.value = minutesToClock(value);
          return;
        }
        onChange(min);
        e.target.value = minutesToClock(min);
      }}
    />
  );
}

// ---------------------------------------------------------------------------

function patchMap(
  map: Record<string, number> | undefined,
  key: string,
  value: number | undefined,
): Record<string, number> | undefined {
  const next = { ...(map ?? {}) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return Object.keys(next).length > 0 ? next : undefined;
}

function patchResource(
  config: SalonConfig,
  onChange: (next: SalonConfig) => void,
  resource: Resource,
  patch: Partial<Resource>,
) {
  onChange({
    ...config,
    resources: config.resources.map((r) => (r.id === resource.id ? { ...r, ...patch } : r)),
  });
}

function problemsFor(problems: Map<string, string>, prefix: string): string[] {
  const out: string[] = [];
  for (const [where, message] of problems) {
    if (where === prefix || where.startsWith(`${prefix}.`)) out.push(message);
  }
  return out;
}

function humanise(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
