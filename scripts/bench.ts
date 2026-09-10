/**
 * Performance benchmark.
 *
 * Two of these paths matter for different reasons. `findAvailability` runs
 * inside a live call while a human waits, so milliseconds there are audible.
 * `listGuests` runs on a dashboard page and is quadratic if written naively,
 * so it is fine at 20 bookings and unusable at 20,000.
 *
 *   npm run bench
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Run against a throwaway store so a benchmark never touches a real book.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "belline-bench-"));
process.env.DATA_DIR = dir;

const { seedIfEmpty } = await import("../src/lib/seed");
const store = await import("../src/lib/store");
const { findAvailability } = await import("../src/lib/booking");
const { listGuests, recallGuest } = await import("../src/lib/guests");
const { addDays, todayIn } = await import("../src/lib/time");
const types = await import("../src/lib/types");
void types;

seedIfEmpty();

const restaurant = store.listLocations().find((l) => l.vertical === "restaurant")!;
const today = todayIn(restaurant.timezone);

const SIZES = [500, 5_000, 20_000];

function fill(count: number) {
  const bookings = [];
  const tables = restaurant.restaurant!.tables;
  for (let i = 0; i < count; i++) {
    const day = addDays(today, i % 90);
    const start = 18 * 60 + (i % 16) * 15;
    bookings.push({
      id: `bk_bench_${i}`,
      ref: "BNCH",
      locationId: restaurant.id,
      vertical: "restaurant" as const,
      status: "confirmed" as const,
      date: day,
      startMin: start,
      endMin: start + 90,
      guestName: `Guest ${i}`,
      // 400 distinct callers, so guest recall has realistic repeat history.
      guestPhone: `+9715${String(1000000 + (i % 400)).padStart(8, "0")}`,
      notes: "",
      partySize: 2,
      tableIds: [tables[i % tables.length].id],
      source: "voice" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  store.replaceAll({ bookings });
}

function time(label: string, runs: number, fn: () => unknown): number {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  const ms = (performance.now() - t0) / runs;
  console.log(`    ${label.padEnd(34)} ${ms.toFixed(2).padStart(9)} ms`);
  return ms;
}

console.log("\n  Belline benchmark\n");

for (const size of SIZES) {
  fill(size);
  console.log(`  ${size.toLocaleString()} bookings on the book`);

  time("findAvailability (in-call)", 20, () =>
    findAvailability(restaurant, {
      locationId: restaurant.id,
      date: addDays(today, 3),
      preferredMin: 20 * 60,
      partySize: 2,
    }),
  );

  time("recallGuest (on pickup)", 20, () =>
    recallGuest(restaurant, "+971510000123"),
  );

  time("listGuests (dashboard)", 3, () => listGuests(restaurant));

  time("listBookings (dashboard)", 20, () =>
    store.listBookings({ locationId: restaurant.id, status: "confirmed" }),
  );

  console.log("");
}

fs.rmSync(dir, { recursive: true, force: true });
