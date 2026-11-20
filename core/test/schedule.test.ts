import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChannelRule, MediaItem } from "../src/model.ts";
import { DAY_MS, adsFor, dayBlocks, dayStart, guide, onAir, programsFor } from "../src/schedule.ts";

const MIN = 60;
const DAY = Date.UTC(2026, 10, 20);                        // a UTC midnight

function ep(id: string, year: number, durationSec: number, extra: Partial<MediaItem> = {}): MediaItem {
  return { id, source: "t", locator: id, kind: "episode", title: id, year, durationSec, ...extra };
}
function ad(id: string, year: number | undefined, durationSec = 30): MediaItem {
  return { id, source: "t", locator: id, kind: "ad", title: id, year, durationSec };
}

const library: MediaItem[] = [
  ...Array.from({ length: 12 }, (_, i) => ep(`sitcom${i}`, 1990 + (i % 6), 22 * MIN, { genres: ["Comedy"], show: i < 6 ? "Seinfeld" : "Frasier" })),
  ep("drama0", 1993, 44 * MIN, { genres: ["Drama"], breaksSec: [9 * MIN, 21 * MIN, 33 * MIN] }),
  ep("old", 1975, 22 * MIN),                                // outside the channel's years
  ad("cola92", 1992), ad("cars93", 1993, 60), ad("toys95", 1995, 15), ad("cereal91", 1991),
  ad("y2k99", 1999), ad("noyear", undefined),
];
const nineties: ChannelRule = { id: "90s", number: 4, name: "Nineties", years: [1990, 1996], seed: "s" };

test("a day is whole slots, back to back, midnight to midnight", () => {
  const blocks = dayBlocks(nineties, programsFor(nineties, library), adsFor(nineties, library), DAY);
  assert.equal(blocks[0].start, DAY);
  assert.equal(blocks.at(-1)!.end, DAY + DAY_MS);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    assert.equal((b.start - DAY) % (30 * MIN * 1000), 0, "starts on :00/:30");
    if (i) assert.equal(b.start, blocks[i - 1].end, "no gaps");
    assert.equal(b.segments[0].start, b.start);
    assert.equal(b.segments.at(-1)!.end, b.end, "playout fills the slot exactly");
    b.segments.forEach((s, j) => j && assert.equal(s.start, b.segments[j - 1].end, "segments are contiguous"));
  }
  const drama = blocks.find((b) => b.program?.id === "drama0")!;
  assert.equal(drama.end - drama.start, 60 * MIN * 1000, "a 44-minute show takes the hour");
});

test("the same channel and day give the same schedule; another seed doesn't", () => {
  const ids = (seed: string) =>
    dayBlocks({ ...nineties, seed }, programsFor(nineties, library), adsFor(nineties, library), DAY)
      .map((b) => b.program?.id).join(",");
  assert.equal(ids("s"), ids("s"));
  assert.notEqual(ids("s"), ids("other"));
});

test("nothing repeats in a day while something unaired still fits", () => {
  const blocks = dayBlocks(nineties, programsFor(nineties, library), adsFor(nineties, library), DAY);
  const first = blocks.slice(0, 13).map((b) => b.program!.id);
  assert.equal(new Set(first).size, 13, first.join(","));
});

test("ads come from the channel's years, fill the breaks, and air at the program's own seams", () => {
  const blocks = dayBlocks(nineties, programsFor(nineties, library), adsFor(nineties, library), DAY);
  for (const b of blocks) {
    const shown = b.segments.filter((s) => s.role === "program").reduce((n, s) => n + (s.toSec - s.fromSec), 0);
    assert.ok(Math.abs(shown - b.program!.durationSec) < 0.01, "the whole program airs");
    for (const s of b.segments.filter((x) => x.role === "ad")) {
      assert.ok(s.item!.year! >= 1989 && s.item!.year! <= 1997, `${s.item!.id} is out of era`);
      assert.notEqual(s.item!.id, "noyear", "an ad with no year is never placed");
    }
  }
  const drama = blocks.find((b) => b.program?.id === "drama0")!;
  const acts = drama.segments.filter((s) => s.role === "program").map((s) => [s.fromSec, s.toSec]);
  assert.deepEqual(acts, [[0, 540], [540, 1260], [1260, 1980], [1980, 2640]], "cut at its detected breaks");
  assert.ok(drama.segments.filter((s) => s.role === "ad").length >= 4, "every break gets ads");
});

test("filters: genre, show and years", () => {
  assert.ok(programsFor({ ...nineties, genres: ["comedy"] }, library).every((m) => m.genres?.includes("Comedy")));
  assert.deepEqual(new Set(programsFor({ ...nineties, shows: ["frasier"] }, library).map((m) => m.show)), new Set(["Frasier"]));
  assert.ok(!programsFor(nineties, library).some((m) => m.id === "old"));
});

test("tuning in at 8:25 lands 25 minutes into the 8:00 slot's playout", () => {
  const at = DAY + (20 * 60 + 25) * MIN * 1000;            // 20:25 UTC
  const now = onAir(nineties, library, at)!;
  assert.ok(now.block.start <= at && at < now.block.end);
  const intoSlot = now.block.segments
    .filter((s) => s.end <= now.segment.start)
    .reduce((n, s) => n + (s.end - s.start), 0) + (now.offsetSec - now.segment.fromSec) * 1000;
  assert.equal(Math.round(intoSlot / 1000), (at - now.block.start) / 1000);
  if (now.segment.role === "program") {
    assert.ok(now.offsetSec > now.segment.fromSec && now.offsetSec < now.segment.toSec);
  }
});

test("the guide spans midnight; a day with nothing that fits ends in a station break", () => {
  const night = guide(nineties, library, DAY + DAY_MS - 3600_000, DAY + DAY_MS + 3600_000);
  assert.ok(night.some((b) => b.start < DAY + DAY_MS) && night.some((b) => b.start >= DAY + DAY_MS));
  assert.equal(dayStart(DAY + 5), DAY);
  const epic = [ep("epic", 1994, 3.5 * 3600), ad("a", 1994)];       // 7 slots; 48 = 6x7 + 6
  const blocks = dayBlocks(nineties, programsFor(nineties, epic), adsFor(nineties, epic), DAY);
  assert.equal(blocks.length, 7);
  assert.equal(blocks.at(-1)!.program, null);
  assert.equal(blocks.at(-1)!.end, DAY + DAY_MS);
  assert.equal(onAir({ ...nineties, years: [1950, 1951] }, library, DAY), null, "no programs, nothing on air");
});
