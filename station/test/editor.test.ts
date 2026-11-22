// The break editor's side of the station, on a real clip: list episodes, set breaks by hand,
// keep today's schedule as it began, hand an episode back to detection, refuse bad input and
// refuse changes from anywhere but this machine's own pages.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { DAY_MS, dayStart } from "../../core/src/schedule.ts";
import { makeClip } from "../../core/test/media.ts";
import { Library } from "../library.ts";
import { createStation } from "../server.ts";

let base = "";
let lib: Library;
let config = "";
let close = () => {};

before(async () => {
  const root = await mkdtemp(join(tmpdir(), "ptm-editor-"));
  const media = join(root, "media");
  // a 150 s "episode" with a seam at 70.5 s
  await makeClip(join(media, "Shows/Alpha (1991)/Season 1/Alpha - S01E01 - Pilot.mp4"),
                 [{ show: 70 }, { gap: 1 }, { show: 79 }]);
  await makeClip(join(media, "Ads/1991/Cola.mp4"), [{ show: 5 }]);
  await mkdir(join(root, "cfg"));
  config = join(root, "cfg", "config.json");
  await writeFile(config, JSON.stringify({
    folders: [media], channels: [{ id: "90s", number: 4, name: "The 90s", years: [1990, 1999], slotMinutes: 3 }],
  }));
  lib = new Library(config);
  await lib.scan();
  const server = createStation(lib).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const episodes = async () => (await (await fetch(`${base}/api/episodes`)).json()).episodes;
const put = (key: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/episodes/${key}/breaks`, {
    method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
const acts = async (from: number) => {
  const body = await (await fetch(`${base}/api/playout?channel=90s&from=${from}&to=${from + 3 * 60_000}`)).json();
  return body.segments.filter((s: { role: string }) => s.role === "program").map((s: { toSec: number }) => s.toSec);
};

test("episodes are listed for the editor, then found, edited and handed back", async () => {
  let [ep] = await episodes();
  assert.equal(ep.status, "pending");
  assert.equal(ep.show, "Alpha");
  assert.equal(ep.delivery, "direct");
  assert.ok(!JSON.stringify(ep).includes("/"), "no file paths");

  await lib.detectBreaks();
  [ep] = await episodes();
  assert.equal(ep.status, "found");
  assert.ok(Math.abs(ep.breaksSec[0] - 70.5) < 0.3, String(ep.breaksSec));
  const found = ep.breaksSec;
  const today = dayStart(Date.now());
  const tomorrow = today + DAY_MS;
  const dayAfter = tomorrow + DAY_MS;

  // set by hand: from tomorrow on; today keeps what it began with (nothing: detection was today)
  let r = await put(ep.key, { breaksSec: [100, 40] });
  assert.equal(r.status, 200);
  ep = await r.json();
  assert.deepEqual(ep.breaksSec, [40, 100]);
  assert.equal(ep.status, "edited");
  assert.deepEqual(ep.today, []);
  assert.deepEqual(await acts(today), [150]);
  assert.deepEqual(await acts(tomorrow), [40, 100, 150]);

  // a second edit the same day still leaves today alone
  ep = await (await put(ep.key, { breaksSec: [75] })).json();
  assert.deepEqual(await acts(today), [150]);
  assert.deepEqual(await acts(tomorrow), [75, 150]);

  // pretend the edit was made yesterday: then it airs today, and a new edit waits for tomorrow
  const rec = Object.values((lib as unknown as { cache: Record<string, { breaksAt?: number; earlier?: unknown[] }> }).cache)
    .find((x) => x.breaksAt)!;
  rec.breaksAt = today - 1000;
  rec.earlier = [];
  ep = await (await put(ep.key, { breaksSec: [30] })).json();
  assert.deepEqual(ep.today, [75]);
  assert.deepEqual(await acts(today), [75, 150]);
  assert.deepEqual(await acts(tomorrow), [30, 150]);
  assert.deepEqual(await acts(dayAfter), [30, 150]);

  // edits survive a restart and a rescan, and detection never replaces them
  const again = new Library(config);
  await again.scan();
  await again.detectBreaks();
  const reread = again.episodeBreaks().find((e) => e.key === ep.key)!;
  assert.equal(reread.status, "edited");
  assert.deepEqual(reread.breaksSec, [30]);

  // handed back: detection runs again and finds the seam; today still airs the edit
  r = await fetch(`${base}/api/episodes/${ep.key}/breaks`, { method: "DELETE" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, "pending");
  await lib.detectBreaks();
  [ep] = await episodes();
  assert.equal(ep.status, "found");
  assert.deepEqual(ep.breaksSec, found);
  assert.deepEqual(await acts(today), [75, 150]);
  assert.ok(Math.abs((await acts(tomorrow))[0] - 70.5) < 0.3);
});

test("bad breaks are refused", async () => {
  const [ep] = await episodes();
  for (const bad of [{ breaksSec: [0] }, { breaksSec: [150] }, { breaksSec: [-3] }, { breaksSec: ["40"] },
                     { breaksSec: [40, 40.5] }, { breaksSec: null }, { breaksSec: Array.from({ length: 30 }, (_, i) => i + 1) }, {}]) {
    const r = await put(ep.key, bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await put("nope", { breaksSec: [10] })).status, 404);
  const text = await fetch(`${base}/api/episodes/${ep.key}/breaks`, { method: "PUT", body: "[10]", headers: { "Content-Type": "text/plain" } });
  assert.equal(text.status, 415);
});

test("changes come only from the station's own pages", async () => {
  const [ep] = await episodes();
  assert.equal((await put(ep.key, { breaksSec: [20] }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await put(ep.key, { breaksSec: [20] }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  const rescan = await fetch(`${base}/api/rescan`, { method: "POST", headers: { Origin: "https://evil.example" } });
  assert.equal(rescan.status, 403);
  const own = await put(ep.key, { breaksSec: [20] }, { Origin: base, "Sec-Fetch-Site": "same-origin" });
  assert.equal(own.status, 200);
});
