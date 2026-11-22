// The lineup editor's side of the station, on real clips: the catalog it builds channels from,
// previews, saving a lineup into the config (keeping everything else there), going back to
// automatic, and refusing bad lineups and changes from other sites.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { makeClip } from "../../core/test/media.ts";
import { cleanChannel, Library } from "../library.ts";
import { createStation } from "../server.ts";

let base = "";
let config = "";
let close = () => {};

before(async () => {
  const root = await mkdtemp(join(tmpdir(), "ptm-lineup-"));
  const media = join(root, "media");
  await makeClip(join(media, "Shows/Alpha (1991)/Season 1/Alpha - S01E01 - Pilot.mp4"), [{ show: 30 }]);
  await makeClip(join(media, "Shows/Alpha (1991)/Season 1/Alpha - S01E02 - Two.mp4"), [{ show: 30 }]);
  await makeClip(join(media, "Shows/Beta (1984)/Season 1/Beta - S01E01 - One.mp4"), [{ show: 30 }]);
  await makeClip(join(media, "Ads/1990/Cola.mp4"), [{ show: 3 }]);
  await mkdir(join(root, "cfg"));
  config = join(root, "cfg", "config.json");
  await writeFile(config, JSON.stringify({ folders: [media], lan: false, port: 8420 }));
  const lib = new Library(config);
  await lib.scan();
  const server = createStation(lib).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const lineup = async () => (await fetch(`${base}/api/lineup`)).json();

test("the editor sees the automatic lineup and what the library holds", async () => {
  const l = await lineup();
  assert.equal(l.auto, true);
  assert.deepEqual(l.channels.map((c: { id: string }) => c.id), ["1980s", "1990s"]);
  assert.deepEqual(l.catalog.years, [1984, 1991]);
  assert.deepEqual(l.catalog.shows, [{ name: "Alpha", years: [1991, 1991], episodes: 2 }, { name: "Beta", years: [1984, 1984], episodes: 1 }]);
  assert.ok(!JSON.stringify(l).includes("/media"), "no file paths");
});

test("a preview says what a channel would air", async () => {
  const r = await send("POST", "/api/lineup/preview", { channel: { id: "x", number: 5, name: "X", years: [1980, 1995] } });
  const p = await r.json();
  assert.equal(p.programs, 3);
  assert.deepEqual(p.shows, [{ name: "Alpha", episodes: 2 }, { name: "Beta", episodes: 1 }]);
  assert.equal(p.ads, 1);
  const only = await (await send("POST", "/api/lineup/preview", { channel: { id: "x", number: 5, name: "X", years: [1980, 1995], shows: ["beta"] } })).json();
  assert.equal(only.programs, 1);
  assert.equal((await send("POST", "/api/lineup/preview", { channel: { id: "X Y", number: 5, name: "X", years: [1980, 1995] } })).status, 400);
});

test("a saved lineup airs at once and lands in the config beside everything else", async () => {
  const lineupIn = [
    { id: "alpha", number: 9, name: "All Alpha", years: [1990, 1999], shows: ["Alpha"], slotMinutes: 30, kinds: ["episode"] },
    { id: "mix", number: 4, name: "The Mix", years: [1980, 1999], slotMinutes: 60, seed: "b" },
  ];
  const before = (await (await fetch(`${base}/api/channels`)).json()).lineupAt;
  const r = await send("PUT", "/api/lineup", { channels: lineupIn });
  assert.equal(r.status, 200, await r.clone().text());
  const saved = await r.json();
  assert.equal(saved.auto, false);
  assert.ok(saved.lineupAt > before);
  // sorted by number, defaults left out
  assert.deepEqual(saved.channels, [
    { id: "mix", number: 4, name: "The Mix", years: [1980, 1999], slotMinutes: 60, seed: "b" },
    { id: "alpha", number: 9, name: "All Alpha", years: [1990, 1999], shows: ["Alpha"] },
  ]);
  const ch = await (await fetch(`${base}/api/channels`)).json();
  assert.deepEqual(ch.channels.map((c: { id: string }) => c.id), ["mix", "alpha"]);
  const now = Date.now();
  // a whole slot: 30-second clips leave most of a 30-minute slot to the station-break card
  const slot = Math.floor(now / 1_800_000) * 1_800_000;
  const playout = await (await fetch(`${base}/api/playout?channel=alpha&from=${slot}&to=${slot + 1_800_000}`)).json();
  assert.ok(playout.segments.some((s: { role: string; title?: string }) => s.role === "program"));
  const file = JSON.parse(await readFile(config, "utf8"));
  assert.equal(file.port, 8420);
  assert.equal(file.lan, false);
  assert.equal(file.channels.length, 2);
  // a restart reads it back
  const again = new Library(config);
  await again.scan();
  assert.equal(again.autoChannels, false);
  assert.deepEqual(again.channels.map((c) => c.id), ["mix", "alpha"]);

  // editing a channel in place changes what it airs (no stale schedule under the same id)
  const g1 = await (await fetch(`${base}/api/guide?from=${now}&to=${now + 3600_000}`)).json();
  await send("PUT", "/api/lineup", { channels: [{ ...lineupIn[1], years: [1984, 1984] }] });
  const g2 = await (await fetch(`${base}/api/guide?from=${now}&to=${now + 3600_000}`)).json();
  assert.match(JSON.stringify(g1.channels[0].blocks), /Alpha/);
  assert.doesNotMatch(JSON.stringify(g2.channels[0].blocks), /Alpha/, "only Beta airs now");

  // back to automatic: the config loses its channels, nothing else
  const auto = await (await send("DELETE", "/api/lineup")).json();
  assert.equal(auto.auto, true);
  assert.deepEqual(auto.channels.map((c: { id: string }) => c.id), ["1980s", "1990s"]);
  const after = JSON.parse(await readFile(config, "utf8"));
  assert.equal(after.channels, undefined);
  assert.equal(after.port, 8420);
});

test("bad lineups are refused, and nothing is written", async () => {
  const ok = { id: "a", number: 2, name: "A", years: [1980, 1990] };
  for (const [bad, why] of [
    [[ok, { ...ok, number: 3 }], "id a is used twice"],
    [[ok, { ...ok, id: "b" }], "number 2 is used twice"],
    [[{ ...ok, years: [1990, 1980] }], "years"],
    [[{ ...ok, kinds: ["ad"] }], "kinds"],
    [[{ ...ok, slotMinutes: 0 }], "slotMinutes"],
    [[{ ...ok, name: "" }], "name"],
    [[{ ...ok, shows: [3] }], "shows"],
    [[], "at least one"],
  ] as const) {
    const r = await send("PUT", "/api/lineup", { channels: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match((await r.json()).error, new RegExp(why.replace(/[()]/g, "\\$&")));
  }
  assert.equal((await send("PUT", "/api/lineup", { nope: 1 })).status, 400);
  assert.equal(JSON.parse(await readFile(config, "utf8")).channels, undefined);
  // only from this station's own pages
  assert.equal((await send("PUT", "/api/lineup", { channels: [ok] }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await send("DELETE", "/api/lineup", undefined, { "Sec-Fetch-Site": "cross-site" })).status, 403);
});

test("a shared channel.json is cleaned to the fields a channel has", () => {
  assert.deepEqual(cleanChannel({ id: "tgif", number: 7, name: " TGIF ", years: [1989, 1998], shows: ["Full House", "Full House"],
                                  kinds: ["episode"], slotMinutes: 30, seed: "", extra: "dropped" }),
                   { id: "tgif", number: 7, name: "TGIF", years: [1989, 1998], shows: ["Full House"] });
});
