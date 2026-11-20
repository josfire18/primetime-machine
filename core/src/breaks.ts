// Where the commercials used to be. Broadcast episodes that had their ads cut out still show
// the seams: a fade to black with the sound dropping out at the same time. ffmpeg finds both
// (blackdetect, silencedetect); a break is where a black stretch and a silent stretch overlap.

import { spawn } from "node:child_process";

export interface Interval {
  start: number;
  end: number;
}

export interface BreakOptions {
  /** Shortest black-and-silent overlap that counts, seconds. */
  minOverlapSec?: number;
  /** Ignore breaks this close to the start or end (cold opens, credits). */
  edgeSec?: number;
  /** Seams closer together than this are one break. */
  mergeSec?: number;
  /** Pixel threshold for "black", 0-1 (ffmpeg pix_th). */
  blackPixel?: number;
  /** Noise floor for "silent", dB (ffmpeg silencedetect n). */
  silenceDb?: number;
}

const DEFAULTS: Required<BreakOptions> = {
  minOverlapSec: 0.2, edgeSec: 60, mergeSec: 10, blackPixel: 0.1, silenceDb: -50,
};

/** Black and silent intervals from ffmpeg's stderr. An interval still open at the end of the file closes at `durationSec`. */
export function parseDetect(stderr: string, durationSec = Infinity): { black: Interval[]; silence: Interval[] } {
  const black: Interval[] = [];
  for (const m of stderr.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)) {
    black.push({ start: Number(m[1]), end: Number(m[2]) });
  }
  const silence: Interval[] = [];
  let open: number | null = null;
  for (const m of stderr.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
    if (m[1] === "start") open = Number(m[2]);
    else if (open !== null) {
      silence.push({ start: open, end: Number(m[2]) });
      open = null;
    }
  }
  if (open !== null && Number.isFinite(durationSec)) silence.push({ start: open, end: durationSec });
  return { black, silence };
}

/** Break points (seconds) where black and silence overlap, away from the edges, merged. */
export function seams(black: Interval[], silence: Interval[], durationSec: number, opts: BreakOptions = {}): number[] {
  const o = { ...DEFAULTS, ...opts };
  const mids: number[] = [];
  for (const b of black) {
    for (const s of silence) {
      const start = Math.max(b.start, s.start);
      const end = Math.min(b.end, s.end);
      if (end - start >= o.minOverlapSec) mids.push((start + end) / 2);
    }
  }
  mids.sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of mids) {
    if (t < o.edgeSec || t > durationSec - o.edgeSec) continue;
    if (out.length && t - out[out.length - 1] < o.mergeSec) continue;
    out.push(Math.round(t * 100) / 100);
  }
  return out;
}

/** Run ffmpeg over a file and return its break points. Decodes the whole file: run it once and cache the result. */
export function detectBreaks(file: string, durationSec: number, opts: BreakOptions = {}): Promise<number[]> {
  const o = { ...DEFAULTS, ...opts };
  const args = [
    "-hide_banner", "-nostats", "-i", file,
    "-vf", `blackdetect=d=${o.minOverlapSec}:pix_th=${o.blackPixel}`,
    "-af", `silencedetect=n=${o.silenceDb}dB:d=${o.minOverlapSec}`,
    "-f", "null", "-",
  ];
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`));
      const { black, silence } = parseDetect(err, durationSec);
      resolve(seams(black, silence, durationSec, o));
    });
  });
}
