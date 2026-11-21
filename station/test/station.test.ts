// The station on a real library: real clips made with ffmpeg, a real config file, a real HTTP
// server on a free port. Checks what a TV screen relies on: the lineup, a guide with whole
// slots, playout that runs back to back from the clock, and media that seeks.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { makeClip } from "../../core/test/media.ts";
import { defaultChannels, Library, loadConfig } from "../library.ts";
import { createStation } from "../server.ts";

let base = "";
let lib: Library;
let close = () => {};

before(async () => {
  const root = await mkdtemp(join(tmpdir(), "ptm-station-"));
  const media = join(root, "media");
  await Promise.all([
    makeClip(join(media, "Shows/Alpha (1991)/Season 1/Alpha - S01E01 - Pilot.mp4"), [{ show: 6 }]),
    makeClip(join(media, "Shows/Alpha (1991)/Season 1/Alpha - S01E02 - Second.mp4"), [{ show: 5 }]),
    makeClip(join(media, "Shows/Beta.S02E03.Thing.1984.mp4"), [{ show: 4 }]),
    makeClip(join(media, "Ads/1990/Cola.mp4"), [{ show: 2 }]),
    makeClip(join(media, "Ads/1984/Cereal.mp4"), [{ show: 2 }]),
  ]);
  const config = join(root, "cfg", "config.json");
  await mkdir(join(root, "cfg"));
  await writeFile(config, JSON.stringify({
    folders: [media],
    // one-minute slots so the tiny clips still fill a guide
    channels: [
      { id: "90s", number: 4, name: "The 90s", years: [1990, 1999], slotMinutes: 1 },
      { id: "80s", number: 2, name: "The 80s", years: [1980, 1989], slotMinutes: 1 },
    ],
  }));
  lib = new Library(config);
  await lib.scan();
  const server = createStation(lib).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const get = async (path: string, init?: RequestInit) => {
  const r = await fetch(base + path, init);
  return { status: r.status, headers: r.headers, body: r.headers.get("content-type")?.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};

test("the lineup is the config's channels, by number", async () => {
  const { body } = await get("/api/channels");
  assert.deepEqual(body.channels.map((c: { id: string }) => c.id), ["80s", "90s"]);
  assert.equal(body.items, 5);
});

test("the guide is whole slots, back to back, with no file paths in it", async () => {
  const from = Date.UTC(2026, 10, 21, 20, 0);
  const { body } = await get(`/api/guide?from=${from}&to=${from + 10 * 60_000}`);
  const nineties = body.channels.find((c: { id: string }) => c.id === "90s");
  assert.ok(nineties.blocks.length >= 10);
  nineties.blocks.forEach((b: { start: number; end: number }, i: number) => {
    assert.equal((b.end - b.start) % 60_000, 0);
    if (i) assert.equal(b.start, nineties.blocks[i - 1].end);
  });
  assert.ok(nineties.blocks.every((b: { program: { show: string } }) => b.program.show === "Alpha"));
  assert.ok(!JSON.stringify(body).includes("/tmp"), "guide leaks a path");
});

test("playout runs back to back from the clock, with era ads, and every src plays", async () => {
  const from = Date.UTC(2026, 10, 21, 20, 0, 30);
  const { body } = await get(`/api/playout?channel=90s&from=${from}&to=${from + 5 * 60_000}`);
  const segs = body.segments;
  assert.ok(segs[0].start <= from && segs[0].end > from, "first segment covers the start");
  segs.forEach((s: { start: number }, i: number) => i && assert.equal(s.start, segs[i - 1].end));
  // every segment knows its guide slot: whole minutes here, containing the segment
  for (const s of segs) {
    assert.ok(s.block.start <= s.start && s.end <= s.block.end, JSON.stringify(s));
    assert.equal((s.block.end - s.block.start) % 60_000, 0);
  }
  const ads = segs.filter((s: { role: string }) => s.role === "ad").map((s: { title: string }) => s.title);
  assert.ok(ads.includes("Cola") && !ads.includes("Cereal"), String(ads));
  for (const src of new Set(segs.filter((s: { src: string }) => s.src).map((s: { src: string }) => s.src))) {
    const r = await get(src as string, { method: "HEAD" });
    assert.equal(r.status, 200, String(src));
    assert.equal(r.headers.get("content-type"), "video/mp4");
  }
});

test("media seeks: byte ranges come back as 206 with the right bytes", async () => {
  const from = Date.UTC(2026, 10, 21, 20, 0);
  const { body } = await get(`/api/playout?channel=80s&from=${from}&to=${from + 60_000}`);
  const src = body.segments.find((s: { role: string }) => s.role === "program").src;
  const item = lib.items.find((m) => m.title === "Thing")!;
  const whole = await readFile(item.locator);
  const r = await get(src, { headers: { Range: "bytes=100-199" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes 100-199/${whole.length}`);
  assert.deepEqual(r.body, whole.subarray(100, 200));
  const tail = await get(src, { headers: { Range: "bytes=-10" } });
  assert.deepEqual(tail.body, whole.subarray(whole.length - 10));
  assert.equal((await get(src, { headers: { Range: `bytes=${whole.length}-` } })).status, 416);
});

test("bad requests are refused cleanly", async () => {
  assert.equal((await get("/media/nope")).status, 404);
  assert.equal((await get("/api/playout?channel=nope")).status, 404);
  assert.equal((await get("/api/guide?from=10&to=5")).status, 400);
  assert.equal((await get(`/api/guide?from=0&to=${13 * 3600_000}`)).status, 400);
  assert.equal((await get("/../station/server.ts")).status, 404);
  assert.equal((await get("/%2e%2e/station/server.ts")).status, 404);
  assert.equal((await get("/api/channels", { method: "DELETE" })).status, 405);
});

test("rescan picks up new files", async () => {
  const folder = (await loadConfig(lib.configPath)).folders[0];
  await makeClip(join(folder, "Ads/1991/Soda.mp4"), [{ show: 1 }]);
  const { body } = await get("/api/rescan", { method: "POST" });
  assert.equal(body.items, 6);
});

test("default channels: one per decade with episodes, plus movies", () => {
  const m = (kind: "episode" | "movie", year: number) => ({ id: `${kind}${year}`, source: "t", locator: "x", kind, title: "t", year, durationSec: 60 });
  const chans = defaultChannels([m("episode", 1972), m("episode", 1994), m("movie", 1968), m("movie", 1981)]);
  assert.deepEqual(chans.map((c) => [c.id, c.years]), [["1970s", [1970, 1979]], ["1990s", [1990, 1999]], ["movies", [1968, 1981]]]);
});

test("only addresses and home-network names reach the station (DNS rebinding)", async () => {
  const { allowedHost, hostOf } = await import("../net.ts");
  const { hostname } = await import("node:os");
  for (const ok of ["127.0.0.1:8420", "localhost", "[::1]:8420", "192.168.1.20:8420", "100.101.102.103",
                    "tv.local", "josfire-main.aegean-lizard.ts.net:8420", "media.home.arpa", hostname()]) {
    assert.ok(allowedHost(hostOf(ok)), ok);
  }
  for (const bad of ["evil.example", "127.0.0.1.evil.example", "localhost.evil.com", "", "attacker.ts.net.evil.com",
                     `${hostname()}.evil.com`]) {
    assert.ok(!allowedHost(hostOf(bad)), bad);
  }
  // and the server enforces it
  const port = new URL(base).port;
  const http = await import("node:http");
  const status = await new Promise<number>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/api/channels", headers: { Host: `evil.example:${port}` } },
      (r) => { r.resume(); resolve(r.statusCode ?? 0); }).on("error", reject);
  });
  assert.equal(status, 403);
});

test("config: lan and port are optional and checked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ptm-cfg-"));
  const cfg = join(dir, "c.json");
  await writeFile(cfg, JSON.stringify({ folders: [] }));
  assert.deepEqual(await loadConfig(cfg), { folders: [], channels: undefined, lan: false, port: 8420 });
  await writeFile(cfg, JSON.stringify({ folders: [], lan: true, port: 9000 }));
  const c = await loadConfig(cfg);
  assert.equal(c.lan, true);
  assert.equal(c.port, 9000);
  await writeFile(cfg, JSON.stringify({ folders: [], lan: "yes" }));
  await assert.rejects(loadConfig(cfg), /lan/);
  await writeFile(cfg, JSON.stringify({ folders: [], port: 70000 }));
  await assert.rejects(loadConfig(cfg), /port/);
});
