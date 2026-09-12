"use client";

import { useState } from "react";
import type { RestaurantConfig, Section, ServiceWindow, Table } from "@/lib/types";
import { Cell, ClockBox, DayPicker, Field, NumberBox, Panel, Row, TextBox, Toggle } from "./fields";

/**
 * The room, and when it is open.
 *
 * A restaurant's diary is a floor plan plus a set of sittings, and both are
 * things the venue already has on paper. The job of this page is to let them
 * type it in once without needing to understand the engine — so the controls
 * are named after the things a host says ("pushes together with", "hold back
 * for walk-ins") rather than after the fields they write to.
 */

let counter = 0;
function freshId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter}`;
}

export default function RoomEditor({
  config,
  onChange,
  problems,
}: {
  config: RestaurantConfig;
  onChange: (next: RestaurantConfig) => void;
  problems: Map<string, string>;
}) {
  const [open, setOpen] = useState<string | null>(null);

  const sections = [...new Set(config.tables.map((t) => t.section))].filter(Boolean);

  function patchTable(id: string, patch: Partial<Table>) {
    onChange({
      ...config,
      tables: config.tables.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  }
  function patchSection(id: string, patch: Partial<Section>) {
    const current = config.sections ?? [];
    const exists = current.some((s) => s.id === id);
    onChange({
      ...config,
      sections: exists
        ? current.map((s) => (s.id === id ? { ...s, ...patch } : s))
        : [...current, { id, ...patch }],
    });
  }
  function patchSitting(id: string, patch: Partial<ServiceWindow>) {
    onChange({
      ...config,
      services: config.services.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  }

  const sectionOf = (id: string) => (config.sections ?? []).find((s) => s.id === id);

  return (
    <>
      {/* ---------------------------------------------------------------- */}
      <Panel title="The floor" hint="How the room behaves as a whole.">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 22 }}>
          <div style={{ minWidth: 230, flex: 1 }}>
            <Field
              label="Turnaround between sittings"
              hint="Time to clear, wipe and re-lay. Without it the book promises a table whose last party is still finding their coats."
              problem={problems.get("resetMinutes")}
            >
              <NumberBox
                value={config.resetMinutes}
                onChange={(v) => onChange({ ...config, resetMinutes: v })}
                suffix="minutes"
                placeholder="0"
                width={70}
              />
            </Field>
          </div>
          <div style={{ minWidth: 230, flex: 1 }}>
            <Field
              label="Covers per slot the kitchen can take"
              hint="Pacing. Applies even when tables are free — it is what stops twelve tables being seated at eight o'clock."
              problem={problems.get("maxCoversPerSlot")}
            >
              <NumberBox
                value={config.maxCoversPerSlot}
                onChange={(v) => onChange({ ...config, maxCoversPerSlot: v ?? 1 })}
                suffix="covers"
                width={70}
              />
            </Field>
          </div>
          <div style={{ minWidth: 230, flex: 1 }}>
            <Field
              label="A manager may seat past that by"
              hint="Never available to the agent. For the moment somebody can see two tables putting their coats on."
            >
              <NumberBox
                value={config.overbookPerSlot}
                onChange={(v) => onChange({ ...config, overbookPerSlot: v })}
                suffix="covers"
                placeholder="0"
                width={70}
              />
            </Field>
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 22 }}>
          <div style={{ minWidth: 230, flex: 1 }}>
            <Field
              label="Largest party you take"
              hint="Above this the agent reads the policy below instead of looking for a table."
              problem={problems.get("maxPartySize")}
            >
              <NumberBox
                value={config.maxPartySize}
                onChange={(v) => onChange({ ...config, maxPartySize: v ?? 2 })}
                suffix="people"
                width={70}
              />
            </Field>
          </div>
          <div style={{ minWidth: 230, flex: 1 }}>
            <Field
              label="Tables you will push together"
              hint="Two is what most rooms do. Three is as far as anybody goes in practice."
            >
              <select
                value={String(config.maxCombine ?? 2)}
                onChange={(e) => onChange({ ...config, maxCombine: Number(e.target.value) })}
              >
                <option value="2">up to two</option>
                <option value="3">up to three</option>
              </select>
            </Field>
          </div>
          <div style={{ minWidth: 230, flex: 1 }}>
            <Field label="Booking grid" hint="The steps times are offered on.">
              <NumberBox
                value={config.slotMinutes}
                onChange={(v) => onChange({ ...config, slotMinutes: v ?? 15 })}
                suffix="minutes"
                width={70}
              />
            </Field>
          </div>
        </div>

        <Field
          label="What the agent says to a party that is too large"
          hint="Read out word for word, so write it as you would say it."
        >
          <textarea
            rows={2}
            value={config.largePartyPolicy}
            onChange={(e) => onChange({ ...config, largePartyPolicy: e.target.value })}
          />
        </Field>
      </Panel>

      {/* ---------------------------------------------------------------- */}
      <Panel
        title="Sections"
        hint="Parts of the room that behave differently. A terrace closes when it rains; a bar paces its own way because the kitchen barely touches it."
      >
        {sections.length === 0 && (
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            Sections appear here once your tables have them. Add tables below first.
          </p>
        )}
        {sections.map((id) => {
          const section = sectionOf(id);
          const seats = config.tables
            .filter((t) => t.section === id)
            .reduce((n, t) => n + t.maxSeats, 0);
          return (
            <Row key={id}>
              <Cell label="Section" width={150}>
                <div style={{ fontSize: 13, fontWeight: 600, paddingTop: 7 }}>{id}</div>
              </Cell>
              <Cell label="Seats" width={70}>
                <div className="muted" style={{ fontSize: 13, paddingTop: 7 }}>
                  {seats}
                </div>
              </Cell>
              <Cell label="Covers per slot here" width={170}>
                <NumberBox
                  value={section?.maxCoversPerSlot}
                  onChange={(v) => patchSection(id, { maxCoversPerSlot: v })}
                  placeholder="no limit"
                  suffix="covers"
                  width={64}
                />
              </Cell>
              <Cell label="Filled" width={130}>
                <select
                  value={String(section?.priority ?? 0)}
                  onChange={(e) => patchSection(id, { priority: Number(e.target.value) })}
                >
                  <option value="2">first</option>
                  <option value="1">then</option>
                  <option value="0">last</option>
                </select>
              </Cell>
              <div style={{ paddingBottom: 9, display: "flex", gap: 16 }}>
                <Toggle
                  checked={section?.online !== false}
                  label="Agent may seat here"
                  onChange={(v) => patchSection(id, { online: v ? undefined : false })}
                />
                <Toggle
                  checked={section?.combinable !== false}
                  label="Tables push together"
                  onChange={(v) => patchSection(id, { combinable: v ? undefined : false })}
                />
              </div>
              {[...problems].filter(([w]) => w.startsWith(`section.${id}`)).map(([w, m]) => (
                <div key={w} style={{ color: "var(--bad)", fontSize: 11.5, width: "100%" }}>
                  {m}
                </div>
              ))}
            </Row>
          );
        })}
      </Panel>

      {/* ---------------------------------------------------------------- */}
      <Panel
        title="Tables"
        hint="The engine seats the tightest fit that works, so a couple never burns a six-top while a two-top stands empty."
        right={
          <button
            className="btn"
            style={{ padding: "5px 11px", fontSize: 12 }}
            onClick={() =>
              onChange({
                ...config,
                tables: [
                  ...config.tables,
                  {
                    id: freshId("tbl"),
                    name: String(config.tables.length + 1),
                    minSeats: 2,
                    maxSeats: 2,
                    section: sections[0] ?? "Main",
                  },
                ],
              })
            }
          >
            Add table
          </button>
        }
      >
        {config.tables.map((table) => {
          const expanded = open === table.id;
          return (
            <Row
              key={table.id}
              onRemove={() =>
                onChange({ ...config, tables: config.tables.filter((t) => t.id !== table.id) })
              }
            >
              <Cell label="Name" width={110}>
                <TextBox value={table.name} onChange={(v) => patchTable(table.id, { name: v })} />
              </Cell>
              <Cell label="Section" width={160}>
                <TextBox
                  value={table.section}
                  placeholder="e.g. Main"
                  onChange={(v) => patchTable(table.id, { section: v })}
                />
              </Cell>
              <Cell label="Seats" width={180}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <NumberBox
                    value={table.minSeats}
                    onChange={(v) => patchTable(table.id, { minSeats: v ?? 1 })}
                    min={1}
                    width={54}
                  />
                  <span className="muted" style={{ fontSize: 12 }}>
                    to
                  </span>
                  <NumberBox
                    value={table.maxSeats}
                    onChange={(v) => patchTable(table.id, { maxSeats: v ?? 2 })}
                    min={1}
                    width={54}
                  />
                </span>
              </Cell>
              <div style={{ paddingBottom: 9 }}>
                <Toggle
                  checked={table.online !== false}
                  label="Agent may give it away"
                  onChange={(v) => patchTable(table.id, { online: v ? undefined : false })}
                />
              </div>
              <button
                className="btn"
                style={{ padding: "6px 12px", fontSize: 12 }}
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : table.id)}
              >
                {expanded ? "Less" : "Joins"}
              </button>

              {[...problems].filter(([w]) => w.startsWith(`table.${table.id}`)).map(([w, m]) => (
                <div key={w} style={{ color: "var(--bad)", fontSize: 11.5, width: "100%" }}>
                  {m}
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
                  <label>Pushes together with</label>
                  <div className="muted" style={{ fontSize: 11.5, marginBottom: 8, lineHeight: 1.45 }}>
                    Leave all of these unticked and the engine assumes any table in the same
                    section will do — which is the old rule, and wrong often enough to matter.
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    {config.tables
                      .filter((t) => t.id !== table.id && t.section === table.section)
                      .map((other) => (
                        <Toggle
                          key={other.id}
                          checked={(table.combinesWith ?? []).includes(other.id)}
                          label={other.name}
                          onChange={(on) => {
                            const current = new Set(table.combinesWith ?? []);
                            if (on) current.add(other.id);
                            else current.delete(other.id);
                            patchTable(table.id, {
                              combinesWith: current.size > 0 ? [...current] : undefined,
                            });
                          }}
                        />
                      ))}
                  </div>
                </div>
              )}
            </Row>
          );
        })}
      </Panel>

      {/* ---------------------------------------------------------------- */}
      <Panel
        title="Sittings"
        hint="When people are seated, and how long they have the table for. Turn times grow with the party — a six-top is not a deuce."
        right={
          <button
            className="btn"
            style={{ padding: "5px 11px", fontSize: 12 }}
            onClick={() =>
              onChange({
                ...config,
                services: [
                  ...config.services,
                  {
                    id: freshId("sit"),
                    name: "dinner",
                    days: [0, 1, 2, 3, 4, 5, 6],
                    start: 18 * 60,
                    end: 23 * 60,
                    lastSeating: 21 * 60 + 30,
                    turnTimes: [
                      { upTo: 2, minutes: 90 },
                      { upTo: 8, minutes: 120 },
                    ],
                  },
                ],
              })
            }
          >
            Add sitting
          </button>
        }
      >
        {config.services.map((sitting) => {
          const expanded = open === sitting.id;
          return (
            <Row
              key={sitting.id}
              onRemove={() =>
                onChange({
                  ...config,
                  services: config.services.filter((s) => s.id !== sitting.id),
                })
              }
            >
              <Cell label="Name" width={140}>
                <TextBox
                  value={sitting.name}
                  onChange={(v) => patchSitting(sitting.id, { name: v })}
                />
              </Cell>
              <Cell label="Runs" width={130}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <ClockBox
                    value={sitting.start}
                    onChange={(v) => patchSitting(sitting.id, { start: v ?? 0 })}
                    width={62}
                  />
                  <span className="muted" style={{ fontSize: 12 }}>
                    –
                  </span>
                  <ClockBox
                    value={sitting.end}
                    onChange={(v) => patchSitting(sitting.id, { end: v ?? 0 })}
                    width={62}
                  />
                </span>
              </Cell>
              <Cell label="Last seating" width={110}>
                <ClockBox
                  value={sitting.lastSeating}
                  onChange={(v) => patchSitting(sitting.id, { lastSeating: v ?? 0 })}
                  width={80}
                />
              </Cell>
              <Cell label="Days" width={250}>
                <DayPicker
                  days={sitting.days}
                  onChange={(days) => patchSitting(sitting.id, { days })}
                />
              </Cell>
              <button
                className="btn"
                style={{ padding: "6px 12px", fontSize: 12 }}
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : sitting.id)}
              >
                {expanded ? "Less" : "Turn times"}
              </button>

              {[...problems].filter(([w]) => w.startsWith(`sitting.${sitting.id}`)).map(([w, m]) => (
                <div key={w} style={{ color: "var(--bad)", fontSize: 11.5, width: "100%" }}>
                  {m}
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
                  <label>How long the table is held</label>
                  <div className="muted" style={{ fontSize: 11.5, marginBottom: 8, lineHeight: 1.45 }}>
                    Read in order, smallest party first: the first line a party fits under wins.
                  </div>
                  {sitting.turnTimes.map((turn, index) => (
                    <div
                      key={index}
                      style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 6 }}
                    >
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        up to
                      </span>
                      <NumberBox
                        value={turn.upTo}
                        onChange={(v) =>
                          patchSitting(sitting.id, {
                            turnTimes: sitting.turnTimes.map((t, i) =>
                              i === index ? { ...t, upTo: v ?? 0 } : t,
                            ),
                          })
                        }
                        min={1}
                        width={54}
                      />
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        people get
                      </span>
                      <NumberBox
                        value={turn.minutes}
                        onChange={(v) =>
                          patchSitting(sitting.id, {
                            turnTimes: sitting.turnTimes.map((t, i) =>
                              i === index ? { ...t, minutes: v ?? 0 } : t,
                            ),
                          })
                        }
                        suffix="min"
                        width={58}
                      />
                      <button
                        className="btn"
                        style={{ padding: "4px 9px", fontSize: 11.5 }}
                        onClick={() =>
                          patchSitting(sitting.id, {
                            turnTimes: sitting.turnTimes.filter((_, i) => i !== index),
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    className="btn"
                    style={{ padding: "5px 11px", fontSize: 12, marginBottom: 14 }}
                    onClick={() =>
                      patchSitting(sitting.id, {
                        turnTimes: [
                          ...sitting.turnTimes,
                          {
                            upTo: (sitting.turnTimes[sitting.turnTimes.length - 1]?.upTo ?? 0) + 2,
                            minutes: 120,
                          },
                        ],
                      })
                    }
                  >
                    Add a size
                  </button>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
                    <Cell label="Covers per slot in this sitting" width={210}>
                      <NumberBox
                        value={sitting.maxCoversPerSlot}
                        onChange={(v) => patchSitting(sitting.id, { maxCoversPerSlot: v })}
                        placeholder={String(config.maxCoversPerSlot)}
                        suffix="covers"
                        width={64}
                      />
                    </Cell>
                    <Cell label="Held back for walk-ins" width={190}>
                      <NumberBox
                        value={sitting.walkInHoldback}
                        onChange={(v) => patchSitting(sitting.id, { walkInHoldback: v })}
                        placeholder="0"
                        suffix="covers"
                        width={64}
                      />
                    </Cell>
                    <Cell label="Notice this sitting needs" width={190}>
                      <NumberBox
                        value={sitting.minNoticeMin}
                        onChange={(v) => patchSitting(sitting.id, { minNoticeMin: v })}
                        placeholder="none"
                        suffix="min"
                        width={64}
                      />
                    </Cell>
                  </div>
                </div>
              )}
            </Row>
          );
        })}
      </Panel>
    </>
  );
}
