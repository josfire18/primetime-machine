// The media side on real files: ffmpeg finds the seams a cut-out commercial leaves, the local
// source reads a library laid out the usual ways, and an episode with detected breaks gets its
// era ads exactly there.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

import { detectBreaks, parseDetect, seams } from "../src/breaks.ts";
import type { ChannelRule, MediaItem } from "../src/model.ts";
import { onAir } from "../src/schedule.ts";
import { LocalFolder, parsePath } from "../src/sources/local.ts";
import { makeClip } from "./media.ts";

let root = "";
before(async () => {
  root = await mkdtemp(join(tmpdir(), "ptm-"));
  await Promise.all([
    // 20s show, 1s black+silent seam, 19s show, seam, 19s show: breaks at 20.5 and 40.5
    makeClip(join(root, "Shows/Seinfeld (1989)/Season 4/Seinfeld - S04E11 - The Contest.mp4"),
             [{ show: 20 }, { gap: 1 }, { show: 19 }, { gap: 1 }, { show: 19 }]),
    makeClip(join(root, "Shows/Frasier.S01E02.Space.Quest.1993.mkv"), [{ show: 3 }]),
    makeClip(join(root, "Ads/1992/Crystal Pepsi.mp4"), [{ show: 2 }]),
    makeClip(join(root, "Ads/Surge (1997).mp4"), [{ show: 2 }]),
    makeClip(join(root, "Movies/Night of the Living Dead (1968).mp4"), [{ show: 2 }]),
  ]);
});

test("filenames: shows, seasons, episodes, years, ads and movies", () => {
  assert.deepEqual(parsePath("Shows/Seinfeld (1989)/Season 4/Seinfeld - S04E11 - The Contest.mkv"),
    { kind: "episode", show: "Seinfeld", season: 4, episode: 11, title: "The Contest", year: 1989 });
  assert.deepEqual(parsePath("Frasier.S01E02.Space.Quest.1993.mkv"),
    { kind: "episode", show: "Frasier", season: 1, episode: 2, title: "Space Quest", year: 1993 });
  assert.deepEqual(parsePath("Ads/1992/Crystal Pepsi.mp4"), { kind: "ad", title: "Crystal Pepsi", year: 1992 });
  assert.deepEqual(parsePath("Commercials/Surge (1997).mp4"), { kind: "ad", title: "Surge", year: 1997 });
  assert.deepEqual(parsePath("Movies/Night of the Living Dead (1968).mp4"),
    { kind: "movie", title: "Night of the Living Dead", year: 1968 });
});

test("ffmpeg finds the black-and-silent seams, and only those", async () => {
  const breaks = await detectBreaks(join(root, "Shows/Seinfeld (1989)/Season 4/Seinfeld - S04E11 - The Contest.mp4"), 60, { edgeSec: 5 });
  assert.equal(breaks.length, 2, String(breaks));
  assert.ok(Math.abs(breaks[0] - 20.5) < 0.3 && Math.abs(breaks[1] - 40.5) < 0.3, String(breaks));
  // black without silence (or the reverse) is not a break
  assert.deepEqual(seams([{ start: 30, end: 31 }], [{ start: 50, end: 51 }], 100, { edgeSec: 5 }), []);
  // a silence still open at the end of the file is closed there
  assert.deepEqual(parseDetect("silence_start: 98.5\n", 100).silence, [{ start: 98.5, end: 100 }]);
});

test("the local source reads the library with real durations", async () => {
  const items = await new LocalFolder(root, "local").list();
  const by = (t: string) => items.find((m) => m.title === t)!;
  assert.equal(items.length, 5);
  assert.ok(Math.abs(by("The Contest").durationSec - 60) < 0.5, String(by("The Contest").durationSec));
  assert.equal(by("Crystal Pepsi").kind, "ad");
  assert.equal(by("Crystal Pepsi").year, 1992);
  assert.equal(by("Space Quest").show, "Frasier");
  assert.ok(by("The Contest").locator.endsWith("The Contest.mp4"));
});

test("end to end: the episode's own seams carry its era's ads, and tune-in resolves to a real file", async () => {
  const items = await new LocalFolder(root, "local").list();
  const contest = items.find((m) => m.title === "The Contest")! as MediaItem;
  contest.breaksSec = await detectBreaks(contest.locator, contest.durationSec, { edgeSec: 5 });
  const rule: ChannelRule = { id: "seinfeld", number: 9, name: "Seinfeld", years: [1989, 1993], shows: ["Seinfeld"], slotMinutes: 1 };
  // breakPoints() ignores seams within a minute of the edges, so stretch the clip to a 3-minute episode
  const ep = { ...contest, durationSec: 220, breaksSec: contest.breaksSec.map((b) => b + 60) };
  const library = [ep, ...items.filter((m) => m.kind === "ad")];
  const at = Date.UTC(2026, 10, 20, 8, 0, 0);
  const now = onAir(rule, library, at)!;
  const segs = now.block.segments;
  const acts = segs.filter((s) => s.role === "program").map((s) => s.toSec);
  assert.deepEqual(acts.slice(0, 2), ep.breaksSec, "the program is cut at its detected seams");
  const ads = segs.filter((s) => s.role === "ad").map((s) => s.item!.title);
  assert.ok(ads.includes("Crystal Pepsi"), String(ads));
  assert.ok(!ads.includes("Surge"), "a 1997 ad never airs on a 1989-1993 channel");
  const playing = now.segment.item ?? null;
  assert.ok(playing === null || playing.locator.startsWith(root));
});
