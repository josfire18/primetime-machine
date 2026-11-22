// The station: one small HTTP server that the TV screens talk to (the desktop app's window,
// later a Roku on the home network). It computes guides and playout from the clock with the
// core scheduler and streams the media files, with Range support so players can seek.
//
//   GET  /api/channels                       the lineup
//   GET  /api/guide?from=ms&to=ms            every channel's programs in a window (<= 12 h)
//   GET  /api/playout?channel=id&from=&to=   one channel's segments in a window (<= 6 h)
//   GET  /media/<key>                        a media file (keys come from playout; no paths)
//   GET  /api/live?key=<key>&at=<sec>        where a live stream for that second really starts
//   GET  /media/<key>/live?start=<sec>       the file through ffmpeg as fragmented MP4 (compat.ts),
//                                            for segments marked "live": codecs a screen can't play
//   GET  /api/breaks                         progress of commercial-break detection
//   POST /api/rescan                         re-read the config and folders
//   GET  /api/episodes                       every episode with its breaks (the break editor)
//   PUT  /api/episodes/<key>/breaks          set them by hand: {"breaksSec": [...]}
//   DELETE /api/episodes/<key>/breaks        hand them back to detection
//   GET  /editor.html                        the break editor
//   GET  /                                   the TV screen (ui/)
//
// It listens on 127.0.0.1 unless told otherwise: nothing is exposed beyond this machine by default.
// Requests must name it by an address or a home-network name (see net.ts: DNS rebinding).
// Changes (rescan, break edits) are taken only from this machine itself, and never from
// another site's page: a browser sends any site's form to 127.0.0.1, Host header and all.

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Block, ChannelRule, MediaItem, Segment } from "../core/src/model.ts";
import { adsFor, DAY_MS, dayBlocks, dayStart, programsFor } from "../core/src/schedule.ts";
import { type Delivery, delivery, liveMime, liveStart, spawnLive } from "./compat.ts";
import { type Library, mediaKey } from "./library.ts";
import { allowedHost, hostOf } from "./net.ts";

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const MAX_GUIDE_MS = 12 * 3600_000;
const MAX_PLAYOUT_MS = 6 * 3600_000;

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mkv": "video/x-matroska", ".ts": "video/mp2t", ".avi": "video/x-msvideo", ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg", ".wmv": "video/x-ms-wmv",
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Days are computed once per channel and scan, then reused by every guide and playout call. */
class DayCache {
  private days = new Map<string, Block[]>();
  private lib: Library;
  constructor(lib: Library) {
    this.lib = lib;
  }

  blocks(rule: ChannelRule, day: number): Block[] {
    const key = `${this.lib.scannedAt}|${rule.id}|${day}|${this.lib.breaksKey(day)}`;
    let b = this.days.get(key);
    if (!b) {
      const items = this.lib.itemsForDay(day);
      const programs = programsFor(rule, items);
      b = programs.length ? dayBlocks(rule, programs, adsFor(rule, items), day) : [];
      if (this.days.size > 256) this.days.clear();
      this.days.set(key, b);
    }
    return b;
  }

  window(rule: ChannelRule, from: number, to: number): Block[] {
    const out: Block[] = [];
    for (let day = dayStart(from); day < to; day += DAY_MS) {
      out.push(...this.blocks(rule, day).filter((b) => b.end > from && b.start < to));
    }
    return out;
  }
}

const programView = (p: MediaItem | null) => p && {
  title: p.title, show: p.show ?? null, season: p.season ?? null, episode: p.episode ?? null,
  year: p.year ?? null, kind: p.kind,
};

const segmentView = (s: Segment, b: Block) => ({
  role: s.role, start: s.start, end: s.end, fromSec: s.fromSec, toSec: s.toSec,
  src: s.item ? `/media/${mediaKey(s.item)}` : null,
  /** Play through /api/live: the file's codecs need ffmpeg on the way. */
  live: s.item ? delivery(s.item).mode === "live" : false,
  title: s.item?.title ?? null,
  program: programView(b.program),
  /** The guide slot this segment belongs to. */
  block: { start: b.start, end: b.end },
});

function window(url: URL, max: number): [number, number] {
  const from = Number(url.searchParams.get("from") ?? Date.now());
  const to = Number(url.searchParams.get("to") ?? from + 3 * 3600_000);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new HttpError(400, "from/to must be epoch ms with from < to");
  if (to - from > max) throw new HttpError(400, `window too long (max ${max / 3600_000} h)`);
  return [from, to];
}

const MAX_BODY = 16 * 1024;

/** A change request is allowed only from this machine, and from the station's own pages. */
function checkOwnMachine(req: IncomingMessage): void {
  const from = req.socket.remoteAddress ?? "";
  const local = from === "::1" || from.startsWith("127.") || from.startsWith("::ffff:127.");
  if (!local) throw new HttpError(403, "changes are made on the station's own computer");
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${req.headers.host}`) throw new HttpError(403, "not from this station's pages");
  if (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"]))) {
    throw new HttpError(403, "not from this station's pages");
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "send JSON");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "not JSON");
  }
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(data);
}

async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, cache: string): Promise<void> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    throw new HttpError(404, "file is gone; rescan the library");
  }
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  const head = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": cache };
  if (req.headers.range && !range) throw new HttpError(416, "unsupported range");
  if (range && (range[1] || range[2])) {
    let start: number;
    let end: number;
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    } else {                                // suffix range: the last N bytes
      start = Math.max(0, size - Number(range[2]));
      end = size - 1;
    }
    if (start >= size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...head, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...head, "Content-Length": size });
  if (req.method === "HEAD") return void res.end();
  createReadStream(file).pipe(res);
}

/** Live ffmpeg streams, oldest first; past MAX_LIVE the oldest is stopped. */
const MAX_LIVE = 4;

export function createStation(lib: Library): Server {
  const days = new DayCache(lib);
  let scanning: Promise<void> | null = null;
  const live: { kill: () => void }[] = [];

  function liveItem(key: string): [MediaItem, Extract<Delivery, { mode: "live" }>] {
    const item = lib.item(key);
    if (!item) throw new HttpError(404, "unknown media");
    const d = delivery(item);
    if (d.mode !== "live") throw new HttpError(400, "this file plays directly");
    return [item, d];
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowedHost(hostOf(req.headers.host))) throw new HttpError(403, "use this station's address or home-network name");
    const url = new URL(req.url ?? "/", "http://station");
    const path = url.pathname;
    const get = req.method === "GET" || req.method === "HEAD";

    if (get && path === "/api/channels") {
      return json(res, {
        scannedAt: lib.scannedAt, items: lib.items.length,
        channels: lib.channels.map((c) => ({ id: c.id, number: c.number, name: c.name, years: c.years })),
      });
    }
    if (get && path === "/api/guide") {
      const [from, to] = window(url, MAX_GUIDE_MS);
      return json(res, {
        from, to,
        channels: lib.channels.map((c) => ({
          id: c.id,
          blocks: days.window(c, from, to).map((b) => ({ start: b.start, end: b.end, program: programView(b.program) })),
        })),
      });
    }
    if (get && path === "/api/playout") {
      const rule = lib.channel(url.searchParams.get("channel") ?? "");
      if (!rule) throw new HttpError(404, "no such channel");
      const [from, to] = window(url, MAX_PLAYOUT_MS);
      const segments = days.window(rule, from, to)
        .flatMap((b) => b.segments.filter((s) => s.end > from && s.start < to).map((s) => segmentView(s, b)));
      return json(res, { channel: rule.id, from, to, segments });
    }
    if (get && path === "/api/breaks") {
      return json(res, lib.breakJob);
    }
    if (get && path === "/api/episodes") {
      return json(res, { job: lib.breakJob, episodes: lib.episodeBreaks().map((e) => {
        const item = lib.item(e.key)!;
        return { ...e, delivery: delivery(item).mode };
      }) });
    }
    const edit = /^\/api\/episodes\/([a-z0-9]+)\/breaks$/.exec(path);
    if (edit && (req.method === "PUT" || req.method === "DELETE")) {
      checkOwnMachine(req);
      const body = req.method === "PUT" ? await readJson(req) : null;
      const breaks = body === null ? null : (body as { breaksSec?: unknown }).breaksSec;
      if (body !== null && !Array.isArray(breaks)) throw new HttpError(400, "send {\"breaksSec\": [...]}");
      try {
        return json(res, await lib.setBreaks(edit[1], breaks));
      } catch (e) {
        if (e instanceof Error && /no such episode/.test(e.message)) throw new HttpError(404, e.message);
        if (e instanceof Error && /^breaks:/.test(e.message)) throw new HttpError(400, e.message);
        throw e;
      }
    }
    if (req.method === "POST" && path === "/api/rescan") {
      checkOwnMachine(req);
      scanning ??= lib.scan().finally(() => { scanning = null; });
      await scanning;
      void lib.detectBreaks();
      return json(res, { scannedAt: lib.scannedAt, items: lib.items.length, channels: lib.channels.length });
    }
    if (get && path === "/api/live") {
      const [item, d] = liveItem(url.searchParams.get("key") ?? "");
      const at = Number(url.searchParams.get("at") ?? 0);
      if (!Number.isFinite(at) || at < 0) throw new HttpError(400, "at must be seconds");
      const start = await liveStart(item, d, at);
      return json(res, { start, src: `/media/${mediaKey(item)}/live?start=${start}`, mime: liveMime(item, d),
                         video: d.video, audio: d.audio });
    }
    if (get && /^\/media\/[a-z0-9]+\/live$/.test(path)) {
      const [item, d] = liveItem(path.split("/")[2]);
      const start = Number(url.searchParams.get("start") ?? 0);
      if (!Number.isFinite(start) || start < 0 || start >= item.durationSec) throw new HttpError(400, "start out of range");
      const p = spawnLive(item.locator, start, d);
      const entry = { kill: () => { if (p.exitCode === null) p.kill("SIGKILL"); } };
      live.push(entry);
      while (live.length > MAX_LIVE) live.shift()!.kill();
      const done = () => {
        entry.kill();
        const i = live.indexOf(entry);
        if (i >= 0) live.splice(i, 1);
      };
      res.on("close", done);
      p.on("close", done);
      p.stderr.resume();
      res.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "no-store" });
      if (req.method === "HEAD") return void res.end();
      p.stdout.pipe(res);
      return;
    }
    if (get && path.startsWith("/media/")) {
      const item = lib.item(path.slice("/media/".length));
      if (!item) throw new HttpError(404, "unknown media");
      return sendFile(req, res, item.locator, "private, max-age=3600");
    }
    if (get) {
      const rel = normalize(decodeURIComponent(path === "/" ? "/index.html" : path)).replace(/^([/\\])+/, "");
      const file = join(UI_DIR, rel);
      if (!file.startsWith(UI_DIR) || rel.split(sep).includes("..")) throw new HttpError(404, "not found");
      try {
        const body = await readFile(file);
        res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      } catch {
        throw new HttpError(404, "not found");
      }
    }
    throw new HttpError(405, "method not allowed");
  }

  return createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) json(res, { error: e instanceof Error ? e.message : String(e) }, status);
      else res.destroy();
    });
  });
}
