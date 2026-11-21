// Playing what a screen can't play as-is.
//
// The TV screen (a browser or the desktop app's Chromium) plays MP4 with H.264 and AAC/MP3,
// and WebM with VP8/VP9/AV1 and Opus/Vorbis. Real libraries are mostly MKV, often with AC3 or
// DTS sound, some HEVC. Those go through ffmpeg as a live, fragmented MP4 that starts where
// the clock says:
//   - the video is copied when the screen can decode it (cheap: the container changes) and
//     re-encoded to H.264 only when it can't (HEVC, MPEG-2, ...);
//   - the sound is copied when it's AAC/MP3/Opus and converted to AAC otherwise.
// A copied video stream can only start on a keyframe, so the start is moved back to the
// keyframe at or before the wanted second, and the screen is told where it really starts.

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { extname } from "node:path";
import { setPriority } from "node:os";
import { promisify } from "node:util";

import type { MediaItem } from "../core/src/model.ts";

const run = promisify(execFile);
/** How far before the start the fast seek lands; the rest is cut exactly. */
const SEEK_MARGIN_SEC = 10;

const MP4_VIDEO = new Set(["h264"]);
const MP4_AUDIO = new Set(["aac", "mp3"]);
const WEBM_VIDEO = new Set(["vp8", "vp9", "av1"]);
const WEBM_AUDIO = new Set(["opus", "vorbis"]);
/** Video the screen decodes inside a fragmented MP4, so it can be copied. */
const COPY_VIDEO = new Set(["h264", "vp9", "av1"]);
/** Sound that can ride along in a fragmented MP4 as-is. */
const COPY_AUDIO = new Set(["aac", "mp3", "opus"]);

export type Delivery =
  | { mode: "direct" }
  | { mode: "live"; video: "copy" | "h264"; audio: "copy" | "aac" | "none" };

/** How a screen gets this file: as it is, or through ffmpeg. Unknown codecs go through ffmpeg. */
export function delivery(item: MediaItem): Delivery {
  const ext = extname(item.locator).toLowerCase();
  const v = item.media?.video;
  const a = item.media?.audio;
  const direct =
    (([".mp4", ".m4v", ".mov"].includes(ext) && v !== undefined && MP4_VIDEO.has(v) && (!a || MP4_AUDIO.has(a))) ||
     (ext === ".webm" && v !== undefined && WEBM_VIDEO.has(v) && (!a || WEBM_AUDIO.has(a))));
  if (direct) return { mode: "direct" };
  return {
    mode: "live",
    video: v !== undefined && COPY_VIDEO.has(v) ? "copy" : "h264",
    audio: !a ? "none" : COPY_AUDIO.has(a) ? "copy" : "aac",
  };
}

/** The last keyframe at or before `atSec` (copied video can only start on one). */
export async function keyframeAtOrBefore(file: string, atSec: number): Promise<number> {
  if (atSec <= 0) return 0;
  const from = Math.max(0, atSec - 30);
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time",
    "-read_intervals", `${from}%${atSec + 0.001}`, "-of", "csv=p=0", file,
  ]);
  let best = from === 0 ? 0 : from;
  let found = false;
  for (const line of stdout.split("\n")) {
    const t = Number(line.trim());
    if (Number.isFinite(t) && t <= atSec + 0.0005 && (!found || t > best)) {
      best = t;
      found = true;
    }
  }
  return found ? best : 0;
}

/** Where a live stream for `atSec` really starts: a keyframe when the video is copied. */
export async function liveStart(item: MediaItem, d: Delivery, atSec: number): Promise<number> {
  const at = Math.max(0, Math.min(atSec, item.durationSec - 0.5));
  if (d.mode === "live" && d.video === "copy") return keyframeAtOrBefore(item.locator, at);
  return Math.round(at * 1000) / 1000;
}

/** ffmpeg arguments for a fragmented MP4 of `file` from `startSec`, to stdout. */
export function liveArgs(file: string, startSec: number, d: Extract<Delivery, { mode: "live" }>): string[] {
  const video = d.video === "copy"
    ? ["-c:v", "copy"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-g", "48",
       "-profile:v", "high", "-level:v", "4.0"];
  const audio = d.audio === "none" ? ["-an"] : d.audio === "copy" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k", "-ac", "2"];
  // Seek fast to a little before the start, then cut exactly on the output side. A fast seek
  // alone keeps the frames before the seek point (at negative timestamps), and a fragmented
  // MP4 has no edit list to hide them, so the stream would begin early.
  const coarse = Math.max(0, startSec - SEEK_MARGIN_SEC);
  return [
    "-v", "error", "-nostdin", "-ss", String(coarse), "-i", file, "-ss", String(Math.round((startSec - coarse) * 1000) / 1000),
    "-map", "0:v:0", ...(d.audio === "none" ? [] : ["-map", "0:a:0"]),
    ...video, ...audio, "-sn", "-dn",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1",
  ];
}

/**
 * The MIME type with codecs of a live stream, for the screen's MediaSource. A copied H.264
 * stream is described from its probed profile and level; a re-encode is always High@4.0
 * (liveArgs sets it).
 */
export function liveMime(item: MediaItem, d: Extract<Delivery, { mode: "live" }>): string {
  const m = item.media ?? {};
  let video: string;
  if (d.video === "h264") video = "avc1.640028";
  else if (m.video === "h264") video = avcCodec(m.videoProfile, m.videoLevel);
  else if (m.video === "vp9") video = "vp09.00.40.08";
  else if (m.video === "av1") video = "av01.0.08M.08";
  else video = "avc1.640028";
  const audio = d.audio === "none" ? null
    : d.audio === "aac" || m.audio === "aac" ? "mp4a.40.2"
    : m.audio === "mp3" ? "mp4a.40.34"
    : m.audio === "opus" ? "opus" : "mp4a.40.2";
  return `video/mp4; codecs="${audio ? `${video}, ${audio}` : video}"`;
}

const AVC_PROFILES: Record<string, string> = {
  "constrained baseline": "42E0", baseline: "4200", main: "4D00", extended: "5800",
  high: "6400", "high 10": "6E00", "high 4:2:2": "7A00", "high 4:4:4 predictive": "F400",
};

/** "avc1.PPCCLL" from ffprobe's profile name and level (31 -> 1F). Unknowns: High@4.0. */
export function avcCodec(profile?: string, level?: number): string {
  const pc = AVC_PROFILES[(profile ?? "").toLowerCase()] ?? "6400";
  const lv = level && level > 0 && level < 256 ? level.toString(16).toUpperCase().padStart(2, "0") : "28";
  return `avc1.${pc}${lv}`;
}

/** Start ffmpeg for a live stream; the caller pipes stdout and kills it when the screen leaves. */
export function spawnLive(file: string, startSec: number, d: Extract<Delivery, { mode: "live" }>) {
  const p = spawn("ffmpeg", liveArgs(file, startSec, d), { stdio: ["ignore", "pipe", "pipe"] });
  // a live re-encode competes with nothing more important than itself: normal priority, but
  // a copy is cheap enough to sit a notch lower
  if (d.video === "copy") try { if (p.pid) setPriority(p.pid, 5); } catch { /* fine */ }
  return p;
}
