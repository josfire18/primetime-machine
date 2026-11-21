// Commercial-break detection in the station, on a real clip with a real seam (black frames and
// silence where an ad was cut): found in the background, kept in the cache, and used from the
// next midnight on, never inside a day that is already airing.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { makeClip } from "../../core/test/media.ts";
import { DAY_MS, dayStart } from "../../core/src/schedule.ts";
import type { AddressInfo } from "node:net";

import { Library } from "../library.ts";
import { createStation } from "../server.ts";

test("breaks are found in the background, cached, and used from the next midnight", async () => {
  const root = await mkdtemp(join(tmpdir(), "ptm-breaks-"));
  const media = join(root, "media");
  // a 150 s "episode": the seam is at 70.5 s
  await makeClip(join(media, "Shows/Alpha (1991)/Season 1/Alpha - S01E01 - Pilot.mp4"),
                 [{ show: 70 }, { gap: 1 }, { show: 79 }]);
  await makeClip(join(media, "Ads/1991/Cola.mp4"), [{ show: 5 }]);
  await mkdir(join(root, "cfg"));
  const config = join(root, "cfg", "config.json");
  await writeFile(config, JSON.stringify({
    folders: [media], channels: [{ id: "90s", number: 4, name: "The 90s", years: [1990, 1999], slotMinutes: 3 }],
  }));
  const lib = new Library(config);
  await lib.scan();
  const ep = () => lib.items.find((m) => m.kind === "episode")!;
  assert.equal(ep().breaksSec, undefined, "nothing detected before the job runs");

  const before = Date.now();
  await lib.detectBreaks();
  assert.deepEqual({ ...lib.breakJob, current: undefined }, { running: false, done: 1, total: 1, failed: 0, current: undefined });

  const today = dayStart(Date.now());
  const tomorrow = today + DAY_MS;
  const on = (day: number) => lib.itemsForDay(day).find((m) => m.kind === "episode")!.breaksSec;
  assert.equal(on(today), undefined, "a break found today must not move today's ads");
  const found = on(tomorrow)!;
  assert.equal(found.length, 1);
  assert.ok(Math.abs(found[0] - 70.5) < 0.3, String(found));

  // the station airs tomorrow's episode cut at the seam, today's in one piece
  const server = createStation(lib).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const acts = async (from: number) => {
    const body = await (await fetch(`${base}/api/playout?channel=90s&from=${from}&to=${from + 3 * 60_000}`)).json();
    return body.segments.filter((s: { role: string }) => s.role === "program").map((s: { toSec: number }) => s.toSec);
  };
  try {
    const t = await acts(tomorrow);
    assert.ok(Math.abs(t[0] - 70.5) < 0.3, `tomorrow's first act should end at the seam: ${t}`);
    const d = await acts(today);
    assert.equal(d.length, 1, `today plays in one piece: ${d}`);
    assert.equal((await (await fetch(`${base}/api/breaks`)).json()).done, 1);
  } finally {
    server.close();
  }

  // a rescan keeps the result for an unchanged file: nothing is decoded again
  const cached = JSON.parse(await readFile(join(root, "cfg", "probe-cache.json"), "utf8"));
  const stamp = Object.values(cached as Record<string, { breaksAt?: number }>).find((r) => r.breaksAt)!.breaksAt!;
  assert.ok(stamp >= before);
  await lib.scan();
  await lib.detectBreaks();
  assert.equal(lib.breakJob.done, 1);
  assert.equal(Object.values((lib as unknown as { cache: Record<string, { breaksAt?: number }> }).cache)
    .find((r) => r.breaksAt)!.breaksAt, stamp, "an unchanged file was decoded again");
});
