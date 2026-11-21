// Files a screen can't play as-is, made for real with ffmpeg: MKV with H.264 and AC3 sound
// (most TV rips), HEVC (newer encodes), VP9 with Opus in MKV. The station plays them through
// ffmpeg as fragmented MP4, from a keyframe when it copies the video, and stops ffmpeg when
// the screen goes away.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { delivery, keyframeAtOrBefore } from "../compat.ts";
import { Library, mediaKey } from "../library.ts";
import { createStation } from "../server.ts";

const run = promisify(execFile);
let lib: Library;
let base = "";
let close = () => {};
let media = "";

async function make(path: string, video: string[], audio: string[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await run("ffmpeg", ["-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10:duration=20",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=20",
    ...video, ...audio, path]);
}

before(async () => {
  const root = await mkdtemp(join(tmpdir(), "ptm-compat-"));
  media = join(root, "media");
  const show = (name: string) => join(media, `Shows/Alpha (1991)/Season 1/${name}`);
  // keyframes every 2.5 s (25 frames at 10 fps) so keyframe snapping is visible
  const h264 = ["-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-keyint_min", "25", "-sc_threshold", "0", "-pix_fmt", "yuv420p"];
  await Promise.all([
    make(show("Alpha - S01E01 - Plain.mp4"), h264, ["-c:a", "aac"]),
    make(show("Alpha - S01E02 - Rip.mkv"), h264, ["-c:a", "ac3"]),
    make(show("Alpha - S01E03 - Newer.mp4"), ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-tag:v", "hvc1"], ["-c:a", "aac"]),
    make(show("Alpha - S01E04 - Web.mkv"), ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-g", "25"], ["-c:a", "libopus"]),
  ]);
  await mkdir(join(root, "cfg"));
  const config = join(root, "cfg", "config.json");
  await writeFile(config, JSON.stringify({ folders: [media], channels: [{ id: "90s", number: 4, name: "90s", years: [1990, 1999] }] }));
  lib = new Library(config);
  await lib.scan();
  const server = createStation(lib).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const item = (title: string) => lib.items.find((m) => m.title === title)!;

test("codecs are probed, and decide direct play or ffmpeg", () => {
  const lvl = item("Rip").media!.videoLevel!;
  assert.ok(Number.isInteger(lvl) && lvl > 0, String(lvl));
  assert.deepEqual(item("Plain").media, { video: "h264", videoProfile: "Constrained Baseline", videoLevel: lvl, audio: "aac" });
  assert.deepEqual(item("Rip").media, { video: "h264", videoProfile: "Constrained Baseline", videoLevel: lvl, audio: "ac3" });
  assert.equal(item("Newer").media!.video, "hevc");
  assert.deepEqual(delivery(item("Plain")), { mode: "direct" });
  assert.deepEqual(delivery(item("Rip")), { mode: "live", video: "copy", audio: "aac" });
  assert.deepEqual(delivery(item("Newer")), { mode: "live", video: "h264", audio: "copy" });
  assert.deepEqual(delivery(item("Web")), { mode: "live", video: "copy", audio: "copy" });
  // unknown codecs (an old cache entry) go through ffmpeg rather than fail on screen
  assert.equal(delivery({ ...item("Plain"), media: undefined }).mode, "live");
});

test("the screen is told exactly what a live stream holds", async () => {
  const { avcCodec, liveMime } = await import("../compat.ts");
  assert.equal(avcCodec("High", 31), "avc1.64001F");
  assert.equal(avcCodec("Constrained Baseline", 11), "avc1.42E00B");
  assert.equal(avcCodec(undefined, undefined), "avc1.640028");
  const rip = `avc1.42E0${item("Rip").media!.videoLevel!.toString(16).toUpperCase().padStart(2, "0")}`;
  assert.equal(liveMime(item("Rip"), delivery(item("Rip")) as never), `video/mp4; codecs="${rip}, mp4a.40.2"`);
  assert.equal(liveMime(item("Newer"), delivery(item("Newer")) as never), 'video/mp4; codecs="avc1.640028, mp4a.40.2"');
  assert.equal(liveMime(item("Web"), delivery(item("Web")) as never), 'video/mp4; codecs="vp09.00.40.08, opus"');
  const r = await (await fetch(`${base}/api/live?key=${mediaKey(item("Rip"))}&at=3`)).json();
  assert.equal(r.mime, `video/mp4; codecs="${rip}, mp4a.40.2"`);
});

test("a copied stream starts on the keyframe at or before the wanted second", async () => {
  assert.equal(await keyframeAtOrBefore(item("Rip").locator, 6), 5);
  assert.equal(await keyframeAtOrBefore(item("Rip").locator, 5), 5);
  assert.equal(await keyframeAtOrBefore(item("Rip").locator, 0), 0);
});

async function liveStream(title: string, at: number): Promise<{ start: number; probe: { streams: { codec_type: string; codec_name: string }[]; format: { duration: string } } }> {
  const r = await (await fetch(`${base}/api/live?key=${mediaKey(item(title))}&at=${at}`)).json();
  const bytes = Buffer.from(await (await fetch(base + r.src)).arrayBuffer());
  const out = join(media, `out-${title}.mp4`);
  await writeFile(out, bytes);
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name", "-of", "json", out]);
  return { start: r.start, probe: JSON.parse(stdout) };
}

test("an MKV with AC3 sound streams as H.264 (copied) + AAC, from a keyframe", async () => {
  const { start, probe } = await liveStream("Rip", 6.2);
  assert.equal(start, 5);
  const codecs = probe.streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort();
  assert.deepEqual(codecs, ["audio:aac", "video:h264"]);
  assert.ok(Math.abs(Number(probe.format.duration) - 15) < 0.6, probe.format.duration);
});

test("HEVC is re-encoded to H.264 and starts exactly where asked", async () => {
  const { start, probe } = await liveStream("Newer", 6.2);
  assert.equal(start, 6.2);
  assert.ok(probe.streams.some((s) => s.codec_type === "video" && s.codec_name === "h264"), JSON.stringify(probe.streams));
  assert.ok(Math.abs(Number(probe.format.duration) - 13.8) < 0.6, probe.format.duration);
});

test("playout marks what needs ffmpeg; direct files refuse the live route", async () => {
  const from = Date.UTC(2026, 10, 21, 20, 0);
  const body = await (await fetch(`${base}/api/playout?channel=90s&from=${from}&to=${from + 4 * 3600_000}`)).json();
  const progs = body.segments.filter((s: { role: string }) => s.role === "program");
  const byTitle = new Map(progs.map((s: { program: { title: string }; live: boolean }) => [s.program.title, s.live]));
  assert.equal(byTitle.get("Plain"), false);
  assert.equal(byTitle.get("Rip"), true);
  assert.equal((await fetch(`${base}/api/live?key=${mediaKey(item("Plain"))}&at=1`)).status, 400);
  assert.equal((await fetch(`${base}/media/${mediaKey(item("Rip"))}/live?start=999`)).status, 400);
});

test("ffmpeg stops when the screen goes away", async () => {
  const count = async () => {
    try {
      const { stdout } = await run("pgrep", ["-fc", "pipe:1"]);
      return Number(stdout.trim());
    } catch {
      return 0;                     // pgrep exits 1 when nothing matches
    }
  };
  const before = await count();
  const ctrl = new AbortController();
  const res = await fetch(`${base}/media/${mediaKey(item("Newer"))}/live?start=0`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  await reader.read();                                   // the stream is flowing
  assert.ok((await count()) > before, "no ffmpeg running for the stream");
  ctrl.abort();
  const deadline = Date.now() + 5000;
  while ((await count()) > before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await count(), before, "ffmpeg kept running after the screen left");
});
